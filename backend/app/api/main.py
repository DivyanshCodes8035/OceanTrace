from __future__ import annotations

import json
import math
import asyncio
import csv
import hmac
import io
import os
import re
import smtplib
import ssl
import tempfile
import uuid
from email.message import EmailMessage
from datetime import date, datetime, time, timezone
from pathlib import Path
from typing import Any

import rasterio
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field
from fastapi.staticfiles import StaticFiles

from app.detection.copernicus import make_scene_preview, process_sentinel1_scene, search_sentinel1
from app.detection.sar import DetectionInputError, detect_sar_dark_features
from app.detection.oil_slick_model import detect_ai_slick_candidates
from app.detection.simulation import make_offline_practice_scene, run_simulated_spill
from app.drift.open_meteo_forcing import fetch_readers
from app.drift.simulation import DriftInputError, estimate_origin
from app.vessels.gfw_presence import AISPresenceError, search_gfw_presence
from app.vessels.matching import VesselMatchingInputError, match_vessel_candidates
from app.response.environment import assess_environment
from app.response.report import build_response_report_pdf

PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEMO_CASE_PATH = PROJECT_ROOT / "data" / "sample" / "demo_case.json"
if not DEMO_CASE_PATH.exists():
    DEMO_CASE_PATH = PROJECT_ROOT / "frontend" / "demo-case.json"
SAVED_CASES_DIR = PROJECT_ROOT / "data" / "cases"
load_dotenv(PROJECT_ROOT / ".env")

app = FastAPI(
    title="OceanTrace API",
    version="0.1.0",
    description="Prototype API for reviewing synthetic maritime pollution investigation cases.",
)
def load_demo_case() -> dict[str, Any]:
    with DEMO_CASE_PATH.open("r", encoding="utf-8") as case_file:
        return json.load(case_file)


class SaveCaseRequest(BaseModel):
    case_data: dict[str, Any]


class NotificationSendRequest(BaseModel):
    demo_mode: bool
    case_id: str = Field(min_length=3, max_length=64)
    jurisdiction: str = Field(min_length=3, max_length=120)
    summary: str = Field(min_length=20, max_length=1000)
    recipients: list[str] = Field(min_length=1, max_length=20)
    authorized_approver: str = Field(min_length=2, max_length=100)
    approval_token: str = Field(min_length=1, max_length=200)
    jurisdiction_confirmed: bool
    confirmation_phrase: str = Field(max_length=12)
    response_report: dict[str, Any]


class EnvironmentAssessmentRequest(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


class ResponseReportRequest(BaseModel):
    report: dict[str, Any]


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "oceantrace-api"}


@app.post("/api/environment/assess")
async def get_environmental_assessment(request: EnvironmentAssessmentRequest) -> dict[str, Any]:
    """Fetch modeled marine/weather conditions and nearby mapped coast/habitat clues."""
    try:
        return await assess_environment(request.latitude, request.longitude)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/reports/response.pdf")
def download_response_report(request: ResponseReportRequest) -> Response:
    """Render the reviewed response assessment as a downloadable PDF."""
    try:
        pdf_bytes = build_response_report_pdf(request.report)
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Could not generate the response PDF.") from exc
    return Response(content=pdf_bytes, media_type="application/pdf",
                    headers={"Content-Disposition": "attachment; filename=OceanTrace-response-report.pdf"})


@app.get("/api/cases/{case_id}")
def get_case(case_id: str) -> dict[str, Any]:
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", case_id):
        raise HTTPException(status_code=404, detail="Case not found")
    case = load_demo_case()
    if case_id == case["case_id"]:
        return case
    path = SAVED_CASES_DIR / (case_id + ".json")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Case not found")
    with path.open("r", encoding="utf-8") as saved_file:
        return json.load(saved_file)


@app.post("/api/cases")
def save_case(request: SaveCaseRequest) -> dict[str, str]:
    """Persist a reviewed real-data lead separately from the synthetic fixture."""
    case = request.case_data
    case_id = str(case.get("case_id", ""))
    if not re.fullmatch(r"[a-zA-Z0-9_-]{3,64}", case_id) or case.get("synthetic") is True:
        raise HTTPException(status_code=422, detail="Choose a valid real-review case ID.")
    if not isinstance(case.get("detection"), dict):
        raise HTTPException(status_code=422, detail="A reviewed detection result is required.")
    SAVED_CASES_DIR.mkdir(parents=True, exist_ok=True)
    destination = SAVED_CASES_DIR / (case_id + ".json")
    if destination.exists():
        raise HTTPException(status_code=409, detail="This case has already been saved.")
    temporary = destination.with_suffix(".tmp")
    try:
        temporary.write_text(json.dumps(case, indent=2, ensure_ascii=False, allow_nan=False), encoding="utf-8")
        temporary.replace(destination)
    except (OSError, TypeError, ValueError) as exc:
        temporary.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="Could not save the case to the project data folder.") from exc
    return {"case_id": case_id, "path": "data/cases/" + case_id + ".json"}


@app.post("/api/notifications/send")
def send_incident_notification(request: NotificationSendRequest) -> dict[str, Any]:
    """Send an approved email only for a saved real-data case and configured allowlist."""
    if request.demo_mode:
        raise HTTPException(status_code=403, detail="Demonstration notices cannot be sent.")
    if request.confirmation_phrase != "SEND" or not request.jurisdiction_confirmed:
        raise HTTPException(status_code=400, detail="Explicit send approval and jurisdiction confirmation are required.")
    configured_approval_token = os.getenv("WAKE_TRACE_NOTIFICATION_APPROVAL_TOKEN", "")
    if not configured_approval_token:
        raise HTTPException(status_code=503, detail="Authorized notification approval is not configured on this server.")
    if not hmac.compare_digest(request.approval_token, configured_approval_token):
        raise HTTPException(status_code=403, detail="The administrator-issued approval code is invalid.")
    if not re.fullmatch(r"[a-zA-Z0-9_-]{3,64}", request.case_id):
        raise HTTPException(status_code=422, detail="Choose a valid saved case ID.")

    case_path = SAVED_CASES_DIR / (request.case_id + ".json")
    if not case_path.is_file():
        raise HTTPException(status_code=404, detail="Save and verify a real-data case before sending.")
    try:
        case = json.loads(case_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=422, detail="The saved case could not be read.") from exc
    if case.get("synthetic") is True or not isinstance(case.get("detection"), dict):
        raise HTTPException(status_code=403, detail="Only a saved real-data review can be used for live notifications.")

    allowed = {
        addr.strip().lower()
        for addr in re.split(r"[,;\s]+", os.getenv("WAKE_TRACE_NOTIFICATION_ALLOWLIST", ""))
        if addr.strip()
    }
    recipients = [addr.strip().lower() for addr in request.recipients]
    email_pattern = re.compile(r"^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$")
    if not all(email_pattern.fullmatch(addr) for addr in recipients):
        raise HTTPException(status_code=422, detail="Enter valid recipient email addresses.")
    if len(set(recipients)) != len(recipients):
        raise HTTPException(status_code=422, detail="Remove duplicate recipient addresses.")
    if not allowed or not set(recipients).issubset(allowed):
        raise HTTPException(status_code=403, detail="Recipients must be configured in the server's verified notification allowlist.")

    host = os.getenv("WAKE_TRACE_SMTP_HOST", "").strip()
    sender = os.getenv("WAKE_TRACE_SMTP_FROM", "").strip()
    username = os.getenv("WAKE_TRACE_SMTP_USERNAME", "")
    password = os.getenv("WAKE_TRACE_SMTP_PASSWORD", "")
    if not host or not sender or not username or not password:
        raise HTTPException(status_code=503, detail="Email delivery is not configured on this OceanTrace server.")
    try:
        port = int(os.getenv("WAKE_TRACE_SMTP_PORT", "587"))
    except ValueError as exc:
        raise HTTPException(status_code=503, detail="The configured email delivery port is invalid.") from exc
    if not 1 <= port <= 65535:
        raise HTTPException(status_code=503, detail="The configured email delivery port is invalid.")

    notification_id = "WT-" + uuid.uuid4().hex[:10].upper()
    message = EmailMessage()
    message["Subject"] = f"OceanTrace incident coordination notice · {request.case_id}"
    message["From"] = sender
    message["To"] = sender
    message["Bcc"] = ", ".join(recipients)
    message.set_content(
        "OceanTrace incident coordination notice\n\n"
        f"Case reference: {request.case_id}\n"
        f"Incident jurisdiction (confirmed by approver): {request.jurisdiction.strip()}\n"
        f"Authorized approver: {request.authorized_approver.strip()}\n"
        f"Notification reference: {notification_id}\n\n"
        "Verified incident summary / requested coordination:\n"
        f"{request.summary.strip()}\n\n"
        "This message records a coordination notification for a saved real-data review. "
        "It does not confirm oil, assign responsibility, or issue an operational deployment order. "
        "Please use the competent incident authority and approved response procedures.\n"
    )
    try:
        report_bytes = build_response_report_pdf(request.response_report)
    except Exception as exc:
        raise HTTPException(status_code=422, detail="The response PDF could not be prepared, so no notification was sent.") from exc
    message.add_attachment(report_bytes, maintype="application", subtype="pdf",
                           filename=f"OceanTrace-response-{request.case_id}.pdf")
    try:
        with smtplib.SMTP(host, port, timeout=20) as client:
            client.ehlo()
            client.starttls(context=ssl.create_default_context())
            client.ehlo()
            client.login(username, password)
            refused = client.send_message(message, from_addr=sender, to_addrs=recipients)
        if refused:
            raise smtplib.SMTPRecipientsRefused(refused)
    except (OSError, smtplib.SMTPException) as exc:
        raise HTTPException(status_code=502, detail="The configured mail service did not confirm delivery. No successful send is claimed.") from exc
    return {"notification_id": notification_id, "sent_count": len(recipients), "status": "accepted_by_smtp"}


class SceneSelection(BaseModel):
    bbox: list[float] = Field(min_length=4, max_length=4, description="WGS84 [west, south, east, north]")
    polarization: str = "VV"


class SimulatedSpillSelection(SceneSelection):
    source_longitude: float = Field(ge=-180, le=180)
    source_latitude: float = Field(ge=-90, le=90)
    seed: int = Field(default=42, ge=0, le=2_147_483_647)


class OfflinePracticeRequest(BaseModel):
    source_longitude: float = Field(default=57.7, ge=57.2, le=58.2)
    source_latitude: float = Field(default=-20.4, ge=-20.8, le=-20.0)
    seed: int = Field(default=42, ge=0, le=2_147_483_647)


class DriftSelection(SceneSelection):
    geometry: dict[str, Any]
    acquired_at: str
    backtrack_hours: int = Field(default=24, ge=6, le=120)
    ensemble_size: int = Field(default=300, ge=50, le=2000)
    seed: int = Field(default=42, ge=0, le=2_147_483_647)


class AISMatchRequest(BaseModel):
    drift: dict[str, Any]
    provider: str = Field(min_length=2, max_length=120)
    dataset: str = Field(min_length=2, max_length=160)
    filename: str = Field(min_length=1, max_length=255)
    csv_text: str = Field(min_length=1, max_length=25_000_000)


class AISPresenceRequest(BaseModel):
    drift: dict[str, Any]


def _validated_bbox(values: list[float], max_span: float = 5.0) -> list[float]:
    if len(values) != 4 or not all(math.isfinite(value) for value in values):
        raise HTTPException(status_code=422, detail="Area must contain four finite WGS84 coordinates.")
    west, south, east, north = values
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise HTTPException(status_code=422, detail="Use west, south, east, north in GeoJSON coordinate order.")
    if east - west > max_span or north - south > max_span:
        raise HTTPException(status_code=422, detail="Choose a smaller ocean area so image processing stays manageable.")
    return values


@app.get("/api/satellite/search")
async def satellite_search(
    west: float,
    south: float,
    east: float,
    north: float,
    start_date: date,
    end_date: date,
    polarization: str = Query("VV", pattern="^(VV|VH|HH|HV)$"),
) -> dict[str, Any]:
    """Search official Copernicus Sentinel-1 GRD scenes for a user-selected area and dates."""
    bbox = _validated_bbox([west, south, east, north])
    if start_date > end_date:
        raise HTTPException(status_code=422, detail="Start date must be on or before end date.")
    if (end_date - start_date).days > 31:
        raise HTTPException(status_code=422, detail="Search at most 32 days at a time.")
    start = datetime.combine(start_date, time.min, tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    end = datetime.combine(end_date, time.max, tzinfo=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    try:
        scenes = await search_sentinel1(bbox=bbox, start=start, end=end, polarization=polarization)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"provider": "Copernicus Data Space", "collection": "sentinel-1-grd", "bbox": bbox,
            "start_date": start, "end_date": end, "polarization": polarization, "scenes": scenes}


@app.post("/api/satellite/scenes/{scene_id}/preview")
async def satellite_scene_preview(scene_id: str, selection: SceneSelection) -> dict[str, Any]:
    """Fetch one real Sentinel-1 scene, show its quicklook, and screen for dark features."""
    bbox = _validated_bbox(selection.bbox, max_span=2.5)
    polarization = selection.polarization.upper()
    if polarization not in {"VV", "VH", "HH", "HV"}:
        raise HTTPException(status_code=422, detail="Unsupported polarization.")
    temporary_path: Path | None = None
    try:
        metadata, geotiff = await process_sentinel1_scene(
            scene_id=scene_id, bbox=bbox, polarization=polarization, width=1200,
        )
        preview = make_scene_preview(geotiff)
        with tempfile.NamedTemporaryFile(suffix=".tif", delete=False) as temporary:
            temporary.write(geotiff)
            temporary_path = Path(temporary.name)
        detection = detect_sar_dark_features(
            temporary_path,
            acquired_at=metadata["datetime"],
            source={"provider": "Copernicus Data Space", "dataset": metadata["dataset"], "product_id": scene_id},
            polarization=polarization,
        )
        try:
            ai_result = await asyncio.to_thread(detect_ai_slick_candidates, temporary_path)
            detection["ai_screen"] = {"status": "complete", **ai_result}
        except Exception as exc:
            # The trained model is optional; preserve the existing SAR screen if
            # its runtime or checkpoint is unavailable, and make that visible.
            detection["ai_screen"] = {"status": "unavailable", "message": str(exc)}
        detection["preview_url"] = preview["preview_url"]
        detection["preview_bounds"] = preview["preview_bounds"]
        detection["provenance"]["input_sources"][0].update({
            "platform": metadata["platform"],
            "product_id": metadata["id"],
            "catalog_url": metadata["catalog_url"],
        })
        detection["provenance"]["settings"]["copernicus_processing"] = metadata["processing_settings"]
        detection["provenance"]["settings"]["copernicus_time_range"] = metadata["processing_time_range"]
    except (RuntimeError, ValueError, DetectionInputError, rasterio.errors.RasterioError) as exc:
        message = str(exc)
        status = 503 if "CDSE_CLIENT_ID" in message or "OAuth client" in message else 502
        raise HTTPException(status_code=status, detail=message) from exc
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
    preview.pop("geotiff", None)
    return {"scene": metadata, "preview": preview, "detection": detection,
            "note": "Real Sentinel-1 image from Copernicus Data Space. Dark regions are candidates for analyst review, not confirmed oil."}


@app.post("/api/satellite/scenes/{scene_id}/simulate")
async def satellite_scene_simulation(scene_id: str, selection: SimulatedSpillSelection) -> dict[str, Any]:
    """Inject and screen a labeled synthetic slick on a copy of a real SAR scene."""
    bbox = _validated_bbox(selection.bbox, max_span=2.5)
    polarization = selection.polarization.upper()
    if polarization not in {"VV", "VH", "HH", "HV"}:
        raise HTTPException(status_code=422, detail="Unsupported polarization.")
    west, south, east, north = bbox
    if not (west <= selection.source_longitude <= east and south <= selection.source_latitude <= north):
        raise HTTPException(status_code=422, detail="Click a source point inside the displayed satellite scene.")
    try:
        metadata, geotiff = await process_sentinel1_scene(
            scene_id=scene_id, bbox=bbox, polarization=polarization, width=1200,
        )
        result = run_simulated_spill(
            geotiff,
            source_lon=selection.source_longitude,
            source_lat=selection.source_latitude,
            acquired_at=metadata["datetime"],
            scene_source={"provider": "Copernicus Data Space", "dataset": metadata["dataset"],
                          "product_id": scene_id, "platform": metadata["platform"],
                          "catalog_url": metadata["catalog_url"]},
            polarization=polarization,
            seed=selection.seed,
        )
        preview = make_scene_preview(result.pop("modified_geotiff"))
        preview.pop("geotiff", None)
    except (RuntimeError, ValueError, DetectionInputError, rasterio.errors.RasterioError) as exc:
        message = str(exc)
        status = 503 if "CDSE_CLIENT_ID" in message or "OAuth client" in message else 502
        raise HTTPException(status_code=status, detail=message) from exc
    result["preview"] = preview
    result["scene"] = metadata
    result["detection"]["provenance"]["settings"]["copernicus_processing"] = metadata["processing_settings"]
    result["detection"]["provenance"]["settings"]["copernicus_time_range"] = metadata["processing_time_range"]
    return result


@app.post("/api/simulation/practice")
def offline_synthetic_practice(selection: OfflinePracticeRequest) -> dict[str, Any]:
    """Run the practice pipeline against locally generated, non-satellite radar-like pixels."""
    acquired_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    geotiff, bbox = make_offline_practice_scene(selection.seed)
    scene = {
        "id": "OFFLINE-SYNTHETIC-PRACTICE",
        "source": "Locally generated synthetic radar-style practice scene",
        "datetime": acquired_at,
        "dataset": "OceanTrace synthetic practice raster",
        "bbox": bbox,
        "platform": "simulation",
        "polarization": "VV (synthetic)",
    }
    try:
        result = run_simulated_spill(
            geotiff,
            source_lon=selection.source_longitude,
            source_lat=selection.source_latitude,
            acquired_at=acquired_at,
            scene_source={"provider": "OceanTrace synthetic practice generator", "dataset": scene["dataset"],
                          "product_id": scene["id"]},
            polarization="VV",
            seed=selection.seed,
        )
        preview = make_scene_preview(result.pop("modified_geotiff"))
        preview.pop("geotiff", None)
    except (ValueError, DetectionInputError, rasterio.errors.RasterioError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    result["preview"] = preview
    result["scene"] = scene
    return result


def _run_real_drift(selection: DriftSelection) -> dict[str, Any]:
    observed = datetime.fromisoformat(selection.acquired_at.replace("Z", "+00:00"))
    if observed.tzinfo is None or observed.utcoffset() != timezone.utc.utcoffset(observed):
        raise DriftInputError("Observation time must include UTC (Z).")
    with tempfile.TemporaryDirectory(prefix="oceantrace-forcing-") as directory:
        readers, sources = fetch_readers(
            geometry=selection.geometry,
            observed_at=observed,
            backtrack_hours=selection.backtrack_hours,
            output_directory=Path(directory),
        )
        try:
            return estimate_origin(
                selection.geometry,
                observed,
                readers=readers,
                input_sources=sources,
                backtrack_hours=selection.backtrack_hours,
                ensemble_size=selection.ensemble_size,
                random_seed=selection.seed,
            )
        finally:
            # OpenDrift's NetCDF readers keep file handles open. Close them
            # before TemporaryDirectory cleanup, especially on Windows.
            for reader in readers:
                dataset = getattr(reader, "Dataset", None)
                close = getattr(dataset, "close", None)
                if callable(close):
                    close()


@app.post("/api/satellite/scenes/{scene_id}/drift")
async def satellite_scene_drift(scene_id: str, selection: DriftSelection) -> dict[str, Any]:
    """Backtrack one analyst-selected real SAR feature with downloaded real forcing."""
    bbox = _validated_bbox(selection.bbox, max_span=2.5)
    if not scene_id or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-" for char in scene_id):
        raise HTTPException(status_code=422, detail="Invalid Copernicus scene identifier.")
    if selection.polarization.upper() not in {"VV", "VH", "HH", "HV"}:
        raise HTTPException(status_code=422, detail="Unsupported polarization.")
    try:
        drift = await asyncio.to_thread(_run_real_drift, selection)
    except (DriftInputError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except (RuntimeError, OSError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    drift["provenance"]["settings"]["scene_id"] = scene_id
    drift["provenance"]["settings"]["scene_bbox"] = bbox
    drift["uncertainty_note"] += (
        " The wind and current products have different grid spacing and analysis methods; "
        "nearshore resolution, sub-grid circulation, wave drift, and oil properties add uncertainty."
    )
    return {
        "drift": drift,
        "note": "OpenDrift backtracked the selected SAR feature using public Open-Meteo ERA5 wind and ERA5-Ocean current reanalysis. The feature is not confirmed oil, and this result does not identify a vessel.",
    }


@app.post("/api/vessels/match")
async def match_uploaded_ais(request: AISMatchRequest) -> dict[str, Any]:
    """Screen an analyst-supplied AIS CSV from an authorized provider."""
    try:
        drift = request.drift
        if not isinstance(drift, dict) or not drift.get("release_window") or not drift.get("origin_zone"):
            raise ValueError("A completed drift estimate is required before AIS matching.")
        reader = csv.DictReader(io.StringIO(request.csv_text.lstrip("\ufeff")))
        required = {"vessel_id", "timestamp", "longitude", "latitude"}
        headers = set(reader.fieldnames or [])
        if not required.issubset(headers):
            raise ValueError("CSV needs vessel_id, timestamp, longitude, and latitude columns.")
        observations = list(reader)
        if len(observations) > 100_000:
            raise ValueError("Choose a smaller AIS export with at most 100,000 position rows.")
        source = {
            "provider": request.provider.strip(),
            "dataset": request.dataset.strip(),
            "filename": Path(request.filename).name,
        }
        result = match_vessel_candidates({"drift": drift}, observations, ais_source=source)
    except (ValueError, VesselMatchingInputError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {
        "vessel_candidates": result["vessel_candidates"],
        "provenance": result["provenance"],
        "note": "These are AIS proximity leads only. AIS gaps are not evidence of absence, and the score is not a probability of responsibility.",
    }


@app.post("/api/vessels/search-presence")
async def search_automatic_ais_presence(request: AISPresenceRequest) -> dict[str, Any]:
    """Fetch aggregated public AIS-presence leads for the modeled origin area."""
    try:
        return await search_gfw_presence(request.drift)
    except AISPresenceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


# Serve the frontend from the same origin as the API in hosted deployments.
# Keep this mount last so it cannot shadow API or OpenAPI routes.
FRONTEND_DIR = PROJECT_ROOT / "frontend"
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
