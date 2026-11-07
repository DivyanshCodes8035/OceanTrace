"""Fetch environmental context for an analyst-selected candidate region."""
from __future__ import annotations

import asyncio
import math
from typing import Any

import httpx

MARINE_URL = "https://marine-api.open-meteo.com/v1/marine"
WEATHER_URL = "https://api.open-meteo.com/v1/forecast"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
EARTH_RADIUS_M = 6_371_008.8


def _distance_to_segment_km(lat: float, lon: float, a: dict[str, Any], b: dict[str, Any]) -> float:
    """Local tangent-plane distance, accurate enough for this screening radius."""
    scale_x = math.cos(math.radians(lat)) * math.pi / 180 * EARTH_RADIUS_M
    scale_y = math.pi / 180 * EARTH_RADIUS_M
    ax, ay = (float(a["lon"]) - lon) * scale_x, (float(a["lat"]) - lat) * scale_y
    bx, by = (float(b["lon"]) - lon) * scale_x, (float(b["lat"]) - lat) * scale_y
    dx, dy = bx - ax, by - ay
    denominator = dx * dx + dy * dy
    fraction = 0.0 if denominator == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / denominator))
    return math.hypot(ax + fraction * dx, ay + fraction * dy) / 1000


def _nearest_coastline_km(lat: float, lon: float, elements: list[dict[str, Any]]) -> float | None:
    nearest: float | None = None
    for element in elements:
        geometry = element.get("geometry", [])
        for left, right in zip(geometry, geometry[1:]):
            distance = _distance_to_segment_km(lat, lon, left, right)
            nearest = distance if nearest is None else min(nearest, distance)
    return round(nearest, 1) if nearest is not None else None


def _nearby_protected_sites(lat: float, lon: float, elements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    sites: list[dict[str, Any]] = []
    for element in elements:
        tags = element.get("tags", {})
        point = element.get("center") or element
        if point.get("lat") is None or point.get("lon") is None:
            continue
        sites.append({
            "name": str(tags.get("name") or tags.get("short_name") or "Mapped sensitive area"),
            "type": str(tags.get("boundary") or tags.get("leisure") or tags.get("natural") or "protected area"),
            "distance_km": round(_distance_to_segment_km(lat, lon, point, point), 1),
            "latitude": float(point["lat"]),
            "longitude": float(point["lon"]),
        })
    return sorted(sites, key=lambda item: item["distance_km"])[:5]


async def assess_environment(latitude: float, longitude: float) -> dict[str, Any]:
    """Return modeled marine/weather conditions and optional OSM coast/habitat clues."""
    params = {"latitude": round(latitude, 4), "longitude": round(longitude, 4), "timezone": "GMT"}
    marine_params = {
        **params,
        "current": "wave_height,wave_period,ocean_current_velocity,ocean_current_direction,sea_surface_temperature",
        "hourly": "wave_height,ocean_current_velocity,ocean_current_direction",
        "forecast_hours": 24,
        "cell_selection": "sea",
        "length_unit": "metric",
    }
    weather_params = {
        **params,
        "current": "wind_speed_10m,wind_direction_10m,wind_gusts_10m",
        "wind_speed_unit": "ms",
    }
    query = f"""[out:json][timeout:25];
way(around:75000,{latitude:.4f},{longitude:.4f})["natural"="coastline"]->.coast;
.coast out geom;
(
  nwr(around:50000,{latitude:.4f},{longitude:.4f})["boundary"="protected_area"];
  nwr(around:50000,{latitude:.4f},{longitude:.4f})["leisure"="nature_reserve"];
  nwr(around:50000,{latitude:.4f},{longitude:.4f})["natural"~"wetland|reef"];
)->.sensitive;
.sensitive out center tags;"""

    timeout = httpx.Timeout(32.0, connect=12.0)
    async with httpx.AsyncClient(timeout=timeout, headers={"User-Agent": "OceanTrace/0.2 (local response-planning prototype)"}) as client:
        try:
            marine_response, weather_response = await asyncio.gather(
                client.get(MARINE_URL, params=marine_params),
                client.get(WEATHER_URL, params=weather_params),
            )
            marine_response.raise_for_status()
            weather_response.raise_for_status()
            marine, weather = marine_response.json(), weather_response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise RuntimeError("Open-Meteo could not return marine and wind conditions for this region.") from exc

        osm_status = "available"
        try:
            osm_response = await client.post(OVERPASS_URL, data={"data": query})
            osm_response.raise_for_status()
            elements = osm_response.json().get("elements", [])
            coastline = [element for element in elements if element.get("type") == "way" and element.get("geometry")]
            protected = [element for element in elements if element.get("tags", {}).get("boundary") == "protected_area"
                         or element.get("tags", {}).get("leisure") == "nature_reserve"
                         or element.get("tags", {}).get("natural") in {"wetland", "reef"}]
            coast_distance = _nearest_coastline_km(latitude, longitude, coastline)
            sites = _nearby_protected_sites(latitude, longitude, protected)
        except (httpx.HTTPError, ValueError, KeyError):
            osm_status, coast_distance, sites = "unavailable", None, []

    current = marine.get("current", {})
    weather_current = weather.get("current", {})
    hourly = marine.get("hourly", {})
    hours = []
    times = hourly.get("time", [])
    for index, time in enumerate(times[:24]):
        hours.append({
            "time": time,
            "wave_height_m": (hourly.get("wave_height") or [None] * len(times))[index],
            "current_velocity": (hourly.get("ocean_current_velocity") or [None] * len(times))[index],
            "current_velocity_unit": marine.get("hourly_units", {}).get("ocean_current_velocity", ""),
            "current_direction_deg": (hourly.get("ocean_current_direction") or [None] * len(times))[index],
        })
    return {
        "location": {"latitude": marine.get("latitude", latitude), "longitude": marine.get("longitude", longitude)},
        "requested_location": {"latitude": latitude, "longitude": longitude},
        "marine": {"time": current.get("time"), "wave_height_m": current.get("wave_height"),
                   "wave_period_s": current.get("wave_period"), "current_velocity": current.get("ocean_current_velocity"),
                   "current_velocity_unit": marine.get("current_units", {}).get("ocean_current_velocity", ""),
                   "current_direction_deg": current.get("ocean_current_direction"),
                   "sea_surface_temperature_c": current.get("sea_surface_temperature"),
                   "units": marine.get("current_units", {})},
        "wind": {"time": weather_current.get("time"), "speed_ms": weather_current.get("wind_speed_10m"),
                 "direction_deg": weather_current.get("wind_direction_10m"), "gusts_ms": weather_current.get("wind_gusts_10m"),
                 "units": weather.get("current_units", {})},
        "next_24_hours": hours,
        "coastal_context": {"nearest_coast_km": coast_distance, "mapped_sensitive_sites": sites,
                            "mapped_sensitive_site_count": len(protected) if osm_status == "available" else None,
                            "mapped_site_distance_basis": "distance to mapped area center; approximate, not nearest-boundary distance",
                            "openstreetmap_status": osm_status},
        "sources": [
            {"name": "Open-Meteo Marine API", "url": "https://open-meteo.com/en/docs/marine-weather-api"},
            {"name": "Open-Meteo Forecast API", "url": "https://open-meteo.com/en/docs"},
            {"name": "OpenStreetMap Overpass API", "url": "https://www.openstreetmap.org/copyright"},
        ],
        "limitations": "Model-based conditions and volunteered map features are approximate. Coastal model skill and OpenStreetMap habitat coverage vary; this is not a spill forecast, field observation, navigation product, or proof that no sensitive habitat exists.",
    }
