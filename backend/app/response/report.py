"""Build a concise, print-ready PDF response assessment."""
from __future__ import annotations

from html import escape
from io import BytesIO
from typing import Any

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import HRFlowable, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


def build_response_report_pdf(report: dict[str, Any]) -> bytes:
    output = BytesIO()
    doc = SimpleDocTemplate(output, pagesize=A4, rightMargin=18 * mm, leftMargin=18 * mm,
                            topMargin=17 * mm, bottomMargin=17 * mm, title="OceanTrace Response Assessment")
    base = getSampleStyleSheet()
    title = ParagraphStyle("WTTitle", parent=base["Title"], fontName="Helvetica-Bold", fontSize=18,
                           leading=22, textColor=colors.HexColor("#12364a"), alignment=TA_LEFT, spaceAfter=5)
    subtitle = ParagraphStyle("WTSubtitle", parent=base["Normal"], fontSize=9, leading=13,
                              textColor=colors.HexColor("#547080"), spaceAfter=9)
    section = ParagraphStyle("WTSection", parent=base["Heading2"], fontSize=11, leading=14,
                             textColor=colors.HexColor("#087f78"), spaceBefore=10, spaceAfter=5)
    body = ParagraphStyle("WTBody", parent=base["BodyText"], fontSize=8.5, leading=12,
                          textColor=colors.HexColor("#243b49"), spaceAfter=3)
    small = ParagraphStyle("WTSmall", parent=body, fontSize=7, leading=9, textColor=colors.HexColor("#5e707b"))
    story: list[Any] = [
        Paragraph("OceanTrace Response Assessment", title),
        Paragraph("Incident context · environmental exposure · proposed actions", subtitle),
        HRFlowable(width="100%", thickness=1.2, color=colors.HexColor("#20aa9e")),
        Spacer(1, 6),
    ]

    def text(value: Any) -> str:
        return escape(str(value if value is not None else "Not available"), quote=False).replace("\n", "<br/>")

    def add_section(label: str, rows: list[tuple[str, Any]]) -> None:
        story.append(Paragraph(escape(label), section))
        data = [[Paragraph(f"<b>{text(key)}</b>", body), Paragraph(text(value), body)] for key, value in rows]
        if data:
            table = Table(data, colWidths=[46 * mm, 126 * mm], repeatRows=0, hAlign="LEFT")
            table.setStyle(TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#eff6f7")),
                ("GRID", (0, 0), (-1, -1), .35, colors.HexColor("#d4e0e4")),
                ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]))
            story.append(table)

    analysis = report.get("analysis", {})
    region = report.get("region", {})
    environment = report.get("environment", {})
    marine = environment.get("marine", {}) if isinstance(environment, dict) else {}
    wind = environment.get("wind", {}) if isinstance(environment, dict) else {}
    coastal = environment.get("coastal_context", {}) if isinstance(environment, dict) else {}
    risk = report.get("risk", {})
    plan = report.get("response_plan", {})
    generated = report.get("generated_at", "")

    add_section("Incident and detected region", [
        ("Case / status", f"{report.get('case_id', 'Practice case')} · {report.get('data_status', 'Review required')}"),
        ("Jurisdiction / location", report.get("jurisdiction") or report.get("location") or "Not verified"),
        ("Report generated", generated),
        ("Region coordinates", f"{region.get('latitude', '—')}, {region.get('longitude', '—')}"),
        ("Screened dark-feature area", f"{region.get('area_km2', '—')} km² (radar feature footprint; not oil volume)"),
        ("Screening evidence", f"{analysis.get('candidate_count', '—')} possible feature(s); score {region.get('screening_score', '—')} / 100; origin estimate {analysis.get('origin_estimate', '—')}; vessel leads {analysis.get('vessel_leads', '—')}"),
    ])
    add_section("Environmental conditions at the selected region", [
        ("Marine model grid cell", f"{environment.get('location', {}).get('latitude', '—')}, {environment.get('location', {}).get('longitude', '—')} (requested feature center: {region.get('latitude', '—')}, {region.get('longitude', '—')})"),
        ("Wave height / period", f"{marine.get('wave_height_m', '—')} m / {marine.get('wave_period_s', '—')} s"),
        ("Surface current", f"{marine.get('current_velocity', '—')} {marine.get('current_velocity_unit', '')}, direction {marine.get('current_direction_deg', '—')}°"),
        ("Wind / gusts", f"{wind.get('speed_ms', '—')} / {wind.get('gusts_ms', '—')} m/s; direction {wind.get('direction_deg', '—')}°"),
        ("Nearest mapped coastline", f"{coastal.get('nearest_coast_km', 'Not available')} km"),
        ("Mapped sensitive places", "; ".join(f"{item.get('name', 'Mapped site')} (~{item.get('distance_km', '—')} km to mapped center)" for item in coastal.get("mapped_sensitive_sites", [])) or "No nearby OSM entry returned; absence is not proof of no habitat"),
        ("Marine data time", marine.get("time", "Not available")),
    ])
    add_section("Response engine assessment", [
        ("Environmental priority", risk.get("priority", "Not assessed")),
        ("Potential impact severity", risk.get("severity", "Not assessed")),
        ("Reason / confidence", risk.get("reason", "Not available")),
    ])

    story.append(Paragraph("Recommended actions for authorized human review", section))
    actions = report.get("recommendations", [])
    for index, action in enumerate(actions, 1):
        if isinstance(action, dict):
            item = f"<b>{text(action.get('title', f'Action {index}'))}</b> — {text(action.get('detail', ''))}"
        else:
            item = text(action)
        story.append(Paragraph(f"{index}. {item}", body))

    tasks = plan.get("tasks", [])
    story.append(Paragraph("Response plan and task tracking", section))
    story.append(Paragraph(f"Selected tactic: <b>{text(plan.get('tactic', 'Not selected'))}</b>. "
                            f"Exercise allocation: booms {text(plan.get('booms', '—'))}, skimmers {text(plan.get('skimmers', '—'))}, "
                            f"sorbent kits {text(plan.get('sorbents', '—'))}. Counts are not verified inventory or operational quantities.", body))
    for task in tasks:
        story.append(Paragraph(f"• {text(task.get('title', 'Task'))}: {text(task.get('status', 'Planned'))}", body))

    story.append(Paragraph("Coordination organizations", section))
    for agency in report.get("agencies", []):
        story.append(Paragraph(f"<b>{text(agency.get('name', 'Organization'))}</b> — {text(agency.get('role', 'Role not specified'))}", body))
    story.append(Paragraph("Sources and limitations", section))
    story.append(Paragraph(text(report.get("limitations", "This assessment is a decision-support aid and not an operational instruction.")), small))
    for source in report.get("sources", []):
        if isinstance(source, dict):
            story.append(Paragraph(f"{text(source.get('name', 'Source'))}: {text(source.get('url', ''))}", small))
    doc.build(story)
    return output.getvalue()
