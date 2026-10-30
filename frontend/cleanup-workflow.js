(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let demoMode = true;
  let loadedLiveCase = null;
  let analysisContext = null;
  const STORAGE_KEY = "waketrace-cleanup-workflow-v3";
  const state = {
    tactic: "balanced",
    sensitive: false,
    dispersant: false,
    resources: { booms: 4, skimmers: 3, sorbents: 5 },
    tasks: { confirm: "planned", booms: "planned", recover: "planned", shoreline: "planned", waste: "planned" },
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved) {
      if (saved.resources && typeof saved.resources === "object") for (const k of Object.keys(state.resources)) state.resources[k] = Math.max(0, Math.min(12, Number(saved.resources[k]) || 0));
      if (saved.tasks && typeof saved.tasks === "object") for (const k of Object.keys(state.tasks)) if (["planned", "active", "done"].includes(saved.tasks[k])) state.tasks[k] = saved.tasks[k];
      state.sensitive = saved.sensitive !== false;
      state.dispersant = saved.dispersant === true;
    }
  } catch { /* storage can be disabled; the workflow still works for this page view */ }
  try { analysisContext = JSON.parse(sessionStorage.getItem("waketrace-response-context") || "null"); } catch { /* optional handoff from the guided demo */ }
  if (!analysisContext) {
    analysisContext = {
      synthetic: true,
      caseLabel: "Offline sample · preview only",
      candidateCount: 1,
      location: "Illustrative practice-scene coordinates",
      originEstimate: false,
      vesselLeadCount: 0,
      detectedRegions: [{
        label: "Sample feature · preview only",
        screeningScore: null,
        geometry: { type: "Polygon", coordinates: [[[57.672, -20.372], [57.688, -20.372], [57.692, -20.383], [57.681, -20.392], [57.670, -20.384], [57.672, -20.372]]] },
      }],
    };
  }
  const persist = () => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* optional local persistence */ }
  };

  $("mode-label").textContent = demoMode ? "DEMO EXERCISE" : "LIVE WORKSPACE · REVIEW REQUIRED";
  $("case-label").textContent = analysisContext?.caseLabel || (analysisContext?.caseId ? `Saved case · ${analysisContext.caseId}` : "Waiting for Step 9 detection");
  if (window.location.protocol === "file:") {
    $("jurisdiction-copy").textContent = "Preview only. Start WakeTrace.bat and open localhost:8080 for detection handoff, environmental checks, and PDF reports.";
    document.querySelector(".jurisdiction-note strong").textContent = "File preview";
  }

  const map = L.map("response-map", { zoomControl: true, scrollWheelZoom: false, attributionControl: false }).setView([0, 0], 2);
  const mapAttribution = L.control.attribution({ prefix: false }).addTo(map);
  mapAttribution.addAttribution("© OpenStreetMap contributors");
  const coordinateGrid = L.gridLayer({ tileSize: 256, noWrap: true });
  coordinateGrid.createTile = (coords) => {
    const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 256;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f3f6f1"; ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = "rgba(89, 116, 103, .13)"; ctx.lineWidth = 1;
    for (let point = 0; point <= 256; point += 64) {
      ctx.beginPath(); ctx.moveTo(point, 0); ctx.lineTo(point, 256); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, point); ctx.lineTo(256, point); ctx.stroke();
    }
    const origin = map.unproject(L.point(coords.x * 256, coords.y * 256), coords.z);
    ctx.fillStyle = "rgba(70, 94, 81, .65)"; ctx.font = "11px system-ui, sans-serif";
    ctx.fillText(`${origin.lat.toFixed(2)}°, ${origin.lng.toFixed(2)}°`, 8, 16);
    return canvas;
  };
  coordinateGrid.addTo(map);
  const planLayer = L.layerGroup().addTo(map);
  let selectedRegion = null, regionCenter = null, regionAreaKm2 = null, environmentData = null;
  const EARTH_RADIUS_KM = 6371.0088;
  function polygonRings(geometry) {
    if (!geometry) return [];
    if (geometry.type === "Polygon") return [geometry.coordinates || []];
    if (geometry.type === "MultiPolygon") return geometry.coordinates || [];
    return [];
  }
  function ringAreaKm2(ring) {
    if (!Array.isArray(ring) || ring.length < 4) return 0;
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [lon1, lat1] = ring[i], [lon2, lat2] = ring[i + 1];
      sum += (lon2 - lon1) * Math.PI / 180 * (2 + Math.sin(lat1 * Math.PI / 180) + Math.sin(lat2 * Math.PI / 180));
    }
    return Math.abs(sum * EARTH_RADIUS_KM * EARTH_RADIUS_KM / 2);
  }
  function geometryAreaKm2(geometry) {
    return polygonRings(geometry).reduce((total, rings) => total + Math.max(0, ringAreaKm2(rings[0]) - rings.slice(1).reduce((sum, ring) => sum + ringAreaKm2(ring), 0)), 0);
  }
  function geometryCenter(geometry) {
    const points = polygonRings(geometry).flatMap((rings) => (rings[0] || []).slice(0, -1)).filter((p) => Array.isArray(p) && p.length >= 2);
    if (!points.length) return null;
    return [points.reduce((sum, p) => sum + Number(p[1]), 0) / points.length,
      points.reduce((sum, p) => sum + Number(p[0]), 0) / points.length];
  }
  function prettyArea(value) { return value == null || !Number.isFinite(value) ? "Not available" : `${value < .01 ? value.toFixed(5) : value < 1 ? value.toFixed(3) : value.toFixed(2)} km²`; }
  function selectDetectedRegion(index) {
    const regions = analysisContext?.detectedRegions || [];
    selectedRegion = regions[Number(index)] || null;
    regionCenter = selectedRegion ? geometryCenter(selectedRegion.geometry) : null;
    regionAreaKm2 = selectedRegion ? geometryAreaKm2(selectedRegion.geometry) : null;
    environmentData = null;
    $("region-coordinates").textContent = regionCenter ? `${regionCenter[0].toFixed(5)}, ${regionCenter[1].toFixed(5)}` : "Not available";
    $("region-area").textContent = prettyArea(regionAreaKm2);
    $("region-description").textContent = selectedRegion
      ? `${selectedRegion.label} · radar screening score ${selectedRegion.screeningScore ?? "not recorded"} / 100. It is a possible dark feature, not confirmed oil.`
      : "No polygon geometry was passed from the detection step.";
    if (analysisContext?.caseLabel === "Offline sample · preview only" && selectedRegion) {
      $("region-description").textContent = "Sample polygon for preview only. Run the guided demo through Step 9 to replace it with a screened candidate.";
    }
    $("assess-environment").disabled = !regionCenter;
    $("advance-hour").disabled = !regionCenter;
    $("environment-status").textContent = regionCenter ? "Ready to request modeled marine conditions and nearby mapped coastline/habitat clues for this feature." : "No detected-region geometry is available for an environmental lookup.";
    renderEnvironment(); renderMap(); updateEngine();
    if (regionCenter) map.fitBounds(L.geoJSON(selectedRegion.geometry).getBounds(), { padding: [55, 55], maxZoom: 12 });
  }
  function initializeRegions() {
    const select = $("region-select");
    const regions = analysisContext?.detectedRegions || [];
    select.replaceChildren();
    regions.forEach((region, index) => {
      const option = document.createElement("option"); option.value = String(index); option.textContent = region.label || `Possible feature ${index + 1}`; select.append(option);
    });
    if (!regions.length) { const option = document.createElement("option"); option.value = ""; option.textContent = "No region geometry passed from Step 9"; select.append(option); }
    select.disabled = !regions.length;
    select.addEventListener("change", () => selectDetectedRegion(select.value));
    selectDetectedRegion(regions.length ? 0 : "");
  }
  const tacticMessages = {
    protect: "Booms prioritize deflection and protection near the mapped shoreline. Skimming remains available offshore when conditions allow.",
    recover: "Skimmers and sorbents prioritize surface recovery offshore. Shoreline protection coverage is reduced in this exercise.",
    balanced: "Booms protect the priority coast while skimmers and sorbents focus on accessible surface oil.",
  };
  const tacticExplanations = {
    protect: ["Protect the coast", "Booms are placed as a floating barrier to help keep or redirect oil away from a selected shoreline. They slow spread; they do not remove oil. Skimming can still collect accessible oil."],
    recover: ["Recover offshore", "Skimmers collect oil from the water surface and sorbents absorb smaller patches or residue. This emphasizes collection, but a separate plan is still needed to protect threatened shores and store recovered oil."],
    balanced: ["Balanced response", "Uses booms to help shield the priority coast while skimmers and sorbents are assigned to recover oil where conditions allow. It still depends on safe sea conditions and available equipment."],
  };
  function renderAnalysisSummary() {
    const c = analysisContext;
    $("analysis-candidates").textContent = c?.caseLabel === "Offline sample · preview only" ? "Sample polygon · preview only" : c?.candidateCount == null ? "No prior summary loaded" : `${c.candidateCount} possible feature${c.candidateCount === 1 ? "" : "s"} screened`;
    $("analysis-case").textContent = c?.caseLabel || (c?.caseId ? `Saved case · ${c.caseId}` : "Complete Step 9 to pass a case summary here");
    $("analysis-origin").textContent = c?.originEstimate == null ? "Not available" : c.originEstimate ? "Possible origin area estimated" : "No origin area returned";
    $("analysis-vessels").textContent = c?.vesselLeadCount == null ? "Not available" : `${c.vesselLeadCount} vessel lead${c.vesselLeadCount === 1 ? "" : "s"} for review`;
    $("analysis-source-badge").textContent = c?.caseLabel === "Offline sample · preview only" ? "OFFLINE PREVIEW" : c?.synthetic === false ? "REAL REVIEW · NOT CONFIRMED" : "SYNTHETIC DEMO";
    if (c?.observationTime) $("analysis-case").textContent = `${c.caseLabel || (c.caseId ? `Saved case · ${c.caseId}` : "Completed analysis")} · ${c.observationTime}`;
  }
  function renderEnvironment() {
    const d = environmentData;
    const marine = d?.marine || {}, wind = d?.wind || {}, coastal = d?.coastal_context || {};
    $("environment-waves").textContent = d ? `${marine.wave_height_m ?? "—"} m` : "Awaiting assessment";
    $("environment-wave-period").textContent = `Wave period · ${marine.wave_period_s ?? "—"} s`;
    $("environment-current").textContent = d ? `${marine.current_velocity ?? "—"} ${marine.current_velocity_unit || ""}`.trim() : "Awaiting assessment";
    $("environment-current-direction").textContent = `Direction · ${marine.current_direction_deg ?? "—"}°`;
    $("environment-wind").textContent = d ? `${wind.speed_ms ?? "—"} m/s · gust ${wind.gusts_ms ?? "—"}` : "Awaiting assessment";
    $("environment-wind-direction").textContent = `Direction · ${wind.direction_deg ?? "—"}°`;
    $("environment-coast").textContent = d ? (coastal.nearest_coast_km == null ? "No mapped line returned" : `${coastal.nearest_coast_km} km`) : "Awaiting assessment";
    const sites = coastal.mapped_sensitive_sites || [];
    $("environment-habitat").textContent = d ? (sites.length ? `${sites.length} nearby mapped record${sites.length === 1 ? "" : "s"}` : "No nearby record returned") : "Awaiting assessment";
    $("environment-habitat-note").textContent = sites.length ? `${sites.slice(0, 2).map((site) => `${site.name} (~${site.distance_km} km to mapped center)`).join(" · ")} · approximate` : "OpenStreetMap coverage can be incomplete";
    $("environment-attribution").textContent = d ? `Model time ${marine.time || wind.time || "not supplied"} UTC · Open-Meteo marine/weather models · OpenStreetMap mapped coast and habitat clues. ${d.limitations || "Check local conditions and authoritative habitat data."}` : "Sources used for this check will appear here. Weather/model output is not a direct sensor reading or navigation forecast.";
  }
  async function assessSelectedEnvironment() {
    if (!regionCenter) return;
    if (window.location.protocol === "file:") {
      $("environment-status").textContent = "This page was opened as a file. Start WakeTrace.bat, then open the Response page from http://localhost:8080 to load environmental conditions.";
      return;
    }
    const buttons = [$("assess-environment"), $("advance-hour")];
    buttons.forEach((button) => { button.disabled = true; });
    $("environment-status").textContent = "Loading modeled waves, current, wind, and nearby mapped coastal context…";
    try {
      const response = await fetch("http://127.0.0.1:8002/api/environment/assess", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latitude: regionCenter[0], longitude: regionCenter[1] }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || `Environmental service returned ${response.status}.`);
      environmentData = data;
      const modelCell = data.location ? ` Nearest marine model cell: ${Number(data.location.latitude).toFixed(3)}, ${Number(data.location.longitude).toFixed(3)}.` : "";
      $("environment-status").textContent = `Conditions requested for ${regionCenter[0].toFixed(4)}, ${regionCenter[1].toFixed(4)}.${modelCell} Use as model-based decision support; confirm with local responders.`;
      renderEnvironment(); updateEngine(); renderMap();
    } catch (error) {
      environmentData = null;
      $("environment-status").textContent = `Could not load conditions: ${error.message || "check that the WakeTrace server and internet connection are available."}`;
      renderEnvironment(); updateEngine();
    } finally {
      buttons[0].disabled = !regionCenter;
      buttons[1].disabled = !regionCenter;
    }
  }
  function updateEngine() {
    const list = $("engine-actions");
    list.replaceChildren();
    let actions;
    if (!analysisContext) {
      $("engine-risk").textContent = "Waiting for Step 9 analysis";
      $("engine-risk-reason").textContent = "Run the guided demo through Step 9 to pass its possible-slick, origin, and vessel-lead summary into this engine.";
      $("engine-severity").textContent = "Not assessed · no case loaded";
      $("engine-severity-reason").textContent = "No completed upstream analysis is available to assess even the illustrative coastal exposure.";
      actions = [["Complete the upstream analysis", "Open the investigation map, run the guided practice case, and finish Step 9."], ["Confirm a possible spill", "A radar feature is a screening lead, not proof of oil. Human review and corroborating observations are needed."], ["Do not dispatch from this screen", "No verified incident data or operational assessment is loaded yet."]];
    } else if (!selectedRegion || !regionCenter) {
      $("engine-risk").textContent = "No mapped candidate selected";
      $("engine-risk-reason").textContent = "A response assessment needs the geometry of a screened region; a candidate count alone is not a location.";
      $("engine-severity").textContent = "Not assessed · no region geometry";
      $("engine-severity-reason").textContent = "The response page did not receive a selected detection boundary from the investigation.";
      actions = [["Return to detection review", "Select a screened region with a mapped polygon before assessing the environment."], ["Confirm the observation", "Dark radar features may have other causes; have a qualified reviewer check the image."], ["Do not infer severity", "No area, oil volume, product type, or environmental context is available for this candidate."]];
    } else if (!environmentData) {
      $("engine-risk").textContent = "Environmental check needed";
      $("engine-risk-reason").textContent = "The candidate location is mapped. Read current marine conditions and nearby coastline/sensitive-place records to inform the review.";
      $("engine-severity").textContent = `Feature area ${prettyArea(regionAreaKm2)} · not oil volume`;
      $("engine-severity-reason").textContent = "The radar footprint gives the size of a possible dark feature. It cannot establish the amount, type, or seriousness of oil.";
      actions = [["Read conditions at this location", "Fetch modeled waves, current, wind, nearest mapped coast, and nearby OpenStreetMap sensitivity records."], ["Confirm possible oil and extent", "Review the satellite image and obtain field or authority confirmation; do not treat the radar screen as a spill measurement."], ["Prepare a cautious mechanical response", "Keep containment and surface recovery options ready for expert review; check equipment operating limits and crew safety on scene."]];
    } else {
      const coastal = environmentData.coastal_context || {};
      const coastKm = coastal.nearest_coast_km;
      const sensitiveSites = coastal.mapped_sensitive_sites || [];
      const closeSites = sensitiveSites.filter((site) => Number(site.distance_km) <= 50);
      const coastNear = coastKm != null && coastKm <= 25;
      const coastDataMissing = coastal.openstreetmap_status !== "available" || coastKm == null;
      if (coastNear || closeSites.length || state.sensitive) {
        $("engine-risk").textContent = "Elevated environmental review priority";
        $("engine-risk-reason").textContent = [
          coastNear ? `nearest mapped coast ${coastKm} km` : null,
          closeSites.length ? `${closeSites.length} mapped sensitive place(s) within 50 km` : null,
          state.sensitive ? "analyst marked shoreline sensitivity for review" : null,
        ].filter(Boolean).join(" · ") + ". This is a screening trigger, not a probability or validated risk score.";
      } else if (coastDataMissing) {
        $("engine-risk").textContent = "Incomplete · local habitat check needed";
        $("engine-risk-reason").textContent = "Coastline or protected-place context is missing. No mapped result must not be treated as proof that sensitive areas are absent.";
      } else {
        $("engine-risk").textContent = "No nearby mapped trigger · continue monitoring";
        $("engine-risk-reason").textContent = `No OSM coastline within 25 km (${coastKm} km to nearest mapped coast) and no sensitive place was returned within 50 km. Local data may be incomplete.`;
      }
      $("engine-severity").textContent = `Oil severity unconfirmed · feature ${prettyArea(regionAreaKm2)}`;
      $("engine-severity-reason").textContent = "This is the mapped radar-feature footprint only. Oil presence, recoverable volume, product type, toxicity, and actual harm are not measured by this workflow.";
      actions = [];
      if (coastNear || closeSites.length || state.sensitive) actions.push(["Prioritize local shoreline and habitat review", "The mapped proximity/sensitivity trigger warrants a check with local environmental specialists and the competent incident authority." ]);
      if (coastDataMissing) actions.push(["Confirm coastline and sensitive habitats", "Use verified local habitat/coastline information; volunteered map coverage is incomplete and can miss protected places." ]);
      actions.push(["Stage mechanical containment and recovery for expert review", "Indian Coast Guard guidance prefers mechanical recovery in Indian waters. For this scenario, local authorities must choose equipment and deployment based on oil type, sea state, access, and equipment limits." ]);
      actions.push(["Use chemicals only after formal review", "Dispersants are not an automatic cleanup action. Their use requires competent authority approval and a case-specific environmental benefit assessment." ]);
    }
    $("engine-confidence").textContent = environmentData ? "Low · model and map clues" : "Low · screening only";
    $("engine-confidence-reason").textContent = environmentData
      ? "Conditions are model-based and mapped habitat coverage may be incomplete. Oil presence and actual ecological impact still need confirmation."
      : "No environmental conditions are loaded yet. The radar candidate alone cannot confirm oil or local impacts.";
    actions.forEach(([title, detail]) => {
      const item = document.createElement("li");
      const heading = document.createElement("b"); heading.textContent = title;
      const copy = document.createElement("span"); copy.textContent = detail;
      item.append(heading, copy); list.append(item);
    });
  }
  function marker(latlng, className, label, popup) {
    return L.marker(latlng, { icon: L.divIcon({ className: "", html: `<span class="cleanup-marker ${className}">${label}</span>`, iconSize: [27, 27], iconAnchor: [13, 13] }) }).bindPopup(popup);
  }
  function renderMap() {
    planLayer.clearLayers();
    if (!selectedRegion?.geometry || !regionCenter) {
      $("map-clock").textContent = "WAITING FOR DETECTED REGION";
      $("map-caption").textContent = "Complete Step 9 or load a reviewed case. The response map will center on the selected detection geometry.";
      return;
    }
    const feature = L.geoJSON(selectedRegion.geometry, { style: { color: "#b7d8ce", weight: 2, dashArray: "5 4", fillColor: "#162b2d", fillOpacity: .78 } })
      .bindPopup("Selected possible radar feature · not confirmed oil").addTo(planLayer);
    const bounds = feature.getBounds();
    const south = bounds.getSouth(), north = bounds.getNorth(), west = bounds.getWest(), east = bounds.getEast();
    const latSpan = Math.max(north - south, .005), lonSpan = Math.max(east - west, .005);
    const boomWeight = state.tactic === "protect" ? 1 : state.tactic === "balanced" ? .58 : .22;
    if (state.resources.booms > 0 && boomWeight > .25) {
      const b = [[regionCenter[0] + latSpan * .9, regionCenter[1] - lonSpan * .7], [regionCenter[0] + latSpan * .7, regionCenter[1]], [regionCenter[0] + latSpan * .9, regionCenter[1] + lonSpan * .7]];
      L.polyline(b, { color: "#33dbc7", weight: 4 + Math.min(state.resources.booms, 6), opacity: .96, dashArray: "8 5", lineCap: "round" }).bindPopup(`${state.resources.booms} boom teams · illustrative placement only`).addTo(planLayer);
    }
    const count = Math.min(state.resources.skimmers, 4);
    for (let i = 0; i < count; i++) {
      const pos = [regionCenter[0] - latSpan * (.45 + .12 * (i % 3)), regionCenter[1] + lonSpan * (.5 + .14 * Math.floor(i / 3))];
      marker(pos, "", "S", `Skimmer unit ${i + 1} · illustrative surface recovery point`).addTo(planLayer);
    }
    const absorb = Math.min(state.resources.sorbents, 4);
    for (let i = 0; i < absorb; i++) {
      const pos = [regionCenter[0] + latSpan * (.45 + .12 * (i % 2)), regionCenter[1] - lonSpan * (.5 + .14 * Math.floor(i / 2))];
      marker(pos, "sorbent", "A", `Sorbent kit ${i + 1} · illustrative absorbent point`).addTo(planLayer);
    }
    for (const site of (environmentData?.coastal_context?.mapped_sensitive_sites || [])) {
      marker([site.latitude, site.longitude], "shore", "!", `${site.name} · mapped OSM clue · verify with authoritative local data`).addTo(planLayer);
    }
    $("map-clock").textContent = analysisContext?.synthetic === false ? "SAVED CASE · REVIEW PLAN" : "DETECTED FEATURE · DEMO PLAN";
    $("map-caption").textContent = `The outlined polygon is the selected detection geometry (${prettyArea(regionAreaKm2)}). Equipment symbols show editable planning examples only; they do not indicate a forecast, confirmed coastline impact, real inventory, or deployment order.${environmentData ? " Mapped habitat clues are shown where returned." : " Read environmental conditions to add mapped context."}`;
    if (environmentData && map.getZoom() < 5) map.fitBounds(feature.getBounds(), { padding: [45, 45], maxZoom: 10 });
  }
  function updateDashboard() {
    const total = Object.values(state.resources).reduce((a, b) => a + b, 0);
    $("resource-total").textContent = `${total} demo units`;
    for (const k of Object.keys(state.resources)) $(`${k}-qty`).textContent = state.resources[k];
    $("sensitive-area").checked = state.sensitive;
    $("dispersant").checked = state.dispersant;
    document.querySelectorAll(".tactic-option").forEach((button) => {
      const selected = button.dataset.tactic === state.tactic;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    $("tactic-learning").replaceChildren();
    const learnTitle = document.createElement("b"); learnTitle.textContent = tacticExplanations[state.tactic][0];
    const learnText = document.createElement("span"); learnText.textContent = tacticExplanations[state.tactic][1];
    $("tactic-learning").append(learnTitle, learnText);
    const protect = state.tactic !== "recover" && state.resources.booms > 0;
    $("containment-status").textContent = protect ? (state.tactic === "balanced" ? "Split containment and recovery" : "Shoreline boom line active") : "No boom deployment assigned";
    $("containment-detail").textContent = `${state.resources.booms} boom teams · ${protect ? "priority coast coverage" : "available for reassignment"}`;
    $("recovery-status").textContent = state.resources.skimmers + state.resources.sorbents ? "Surface recovery staged" : "No recovery units assigned";
    $("recovery-detail").textContent = `${state.resources.skimmers} skimmers · ${state.resources.sorbents} sorbent kits assigned`;
    $("shoreline-status").textContent = state.sensitive ? "Habitat review flagged" : "Local habitat review";
    $("shoreline-detail").textContent = state.sensitive ? "Planning assumption · verify against authoritative local data" : "No analyst flag · local review still required";
    $("tactic-feedback").textContent = state.dispersant
      ? `${tacticMessages[state.tactic]} Dispersant consideration flagged: hold for competent authority approval and case-specific NEBA; it transfers oil into droplets in the water column.`
      : tacticMessages[state.tactic] + " No dispersant action is selected.";
    updateEngine();
    renderMap();
    persist();
  }
  document.querySelectorAll(".tactic-option").forEach((button) => button.addEventListener("click", () => { state.tactic = button.dataset.tactic; updateDashboard(); }));
  $("apply-suggested-plan").addEventListener("click", () => {
    state.tactic = "balanced";
    state.sensitive = false;
    state.dispersant = false;
    updateDashboard();
    $("tactic-feedback").scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  document.querySelectorAll(".qty-button").forEach((button) => button.addEventListener("click", () => {
    const key = button.dataset.resource;
    state.resources[key] = Math.max(0, Math.min(12, state.resources[key] + Number(button.dataset.change)));
    updateDashboard();
  }));
  $("sensitive-area").addEventListener("change", (e) => { state.sensitive = e.target.checked; updateDashboard(); });
  $("dispersant").addEventListener("change", (e) => { state.dispersant = e.target.checked; updateDashboard(); });
  $("assess-environment").addEventListener("click", assessSelectedEnvironment);
  $("advance-hour").addEventListener("click", assessSelectedEnvironment);
  renderAnalysisSummary();
  renderEnvironment();
  initializeRegions();
  updateDashboard();
  setTimeout(() => map.invalidateSize(), 120);

  const taskSelects = [...document.querySelectorAll(".task-row select")];
  taskSelects.forEach((select) => {
    const row = select.closest(".task-row");
    select.value = state.tasks[row.dataset.task];
    row.dataset.state = select.value;
    select.addEventListener("change", () => { state.tasks[row.dataset.task] = select.value; row.dataset.state = select.value; updateTasks(); persist(); });
  });
  function updateTasks() {
    const done = Object.values(state.tasks).filter((v) => v === "done").length;
    $("task-progress-label").textContent = `${done} of ${taskSelects.length} complete`;
    $("task-progress-bar").style.width = `${done / taskSelects.length * 100}%`;
  }
  updateTasks();

  function buildReportObject() {
    const tasks = [...document.querySelectorAll(".task-row")].map((row) => ({
      title: row.querySelector("b").textContent,
      status: row.querySelector("select").selectedOptions[0].textContent,
    }));
    const actions = [...document.querySelectorAll("#engine-actions li")].map((item) => ({
      title: item.querySelector("b")?.textContent || "Recommended action",
      detail: item.querySelector("span")?.textContent || "",
    }));
    const agencies = [...document.querySelectorAll(".agency-row")].filter((row) => row.querySelector("input").checked).map((row) => ({
      name: row.querySelector("b").textContent,
      role: row.querySelector("small").textContent,
    }));
    return {
      generated_at: new Date().toISOString(),
      case_id: analysisContext?.caseId || analysisContext?.caseLabel || "Practice case",
      data_status: analysisContext?.synthetic === false ? "Saved real-data review · not confirmation of oil" : "Synthetic practice scenario · not a real incident",
      location: analysisContext?.synthetic === false ? ($("live-jurisdiction").value.trim() || "Jurisdiction not verified") : (analysisContext?.location || "Practice-scene coordinates shown below; demo geography only"),
      jurisdiction: analysisContext?.synthetic === false ? ($("live-jurisdiction").value.trim() || "Not verified") : "Illustrative exercise; competent local jurisdiction not applicable",
      analysis: { candidate_count: analysisContext?.candidateCount ?? "Not available", origin_estimate: analysisContext?.originEstimate == null ? "Not available" : analysisContext.originEstimate ? "Estimated · uncertain" : "Not returned", vessel_leads: analysisContext?.vesselLeadCount ?? "Not available" },
      region: { latitude: regionCenter?.[0]?.toFixed(5) ?? "—", longitude: regionCenter?.[1]?.toFixed(5) ?? "—", area_km2: regionAreaKm2 == null ? "—" : regionAreaKm2.toFixed(5), screening_score: selectedRegion?.screeningScore ?? "Not recorded" },
      environment: environmentData || {},
      risk: { priority: $("engine-risk").textContent, severity: $("engine-severity").textContent, reason: `${$("engine-risk-reason").textContent} ${$("engine-severity-reason").textContent}` },
      recommendations: actions,
      response_plan: { tactic: state.tactic, booms: `${state.resources.booms} demo teams`, skimmers: `${state.resources.skimmers} demo units`, sorbents: `${state.resources.sorbents} demo kits`, tasks },
      agencies,
      limitations: `This is a decision-support summary, not incident confirmation, a validated severity score, a forecast, or deployment order. Radar-feature area is not oil volume. Conditions are model-based; mapped habitat records may be incomplete. Verify with the competent authority, local observations, oil properties, safety and equipment limits. Indian agencies are representative names for the India-focused demo and are not responsible for incidents outside their jurisdiction. Demo notification previews are not sent. Sources: Indian Coast Guard marine environment guidance https://indiancoastguard.gov.in/marine-environment ; Indian Coast Guard 2025 dispersant guidance https://indiancoastguard.gov.in/sites/default/files/202408011002435750687OSDGuidelines2025.pdf ; INCOIS OOSA https://oosa.incois.gov.in/ ; Open-Meteo https://open-meteo.com/en/docs/marine-weather-api ; OpenStreetMap https://www.openstreetmap.org/copyright .`,
      sources: [...(environmentData?.sources || []),
        { name: "Indian Coast Guard · Marine Environment", url: "https://indiancoastguard.gov.in/marine-environment" },
        { name: "Indian Coast Guard · Oil Spill Dispersant Guidelines 2025", url: "https://indiancoastguard.gov.in/sites/default/files/202408011002435750687OSDGuidelines2025.pdf" },
        { name: "ESSO-INCOIS OOSA", url: "https://oosa.incois.gov.in/" },
      ],
    };
  }
  async function downloadResponsePdf(report) {
    const response = await fetch("http://127.0.0.1:8002/api/reports/response.pdf", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ report }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.detail || `PDF service returned ${response.status}.`);
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a"); link.href = url;
    link.download = `waketrace-response-report-${new Date().toISOString().slice(0, 10)}.pdf`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $("generate-report").addEventListener("click", async () => {
    const button = $("generate-report"); button.disabled = true; button.textContent = "Preparing PDF…";
    const report = buildReportObject();
    $("report-content").textContent = JSON.stringify(report, null, 2);
    $("incident-report-preview").open = true;
    if (window.location.protocol === "file:") {
      $("environment-status").textContent = "Start WakeTrace.bat and open this page through http://localhost:8080 to create the PDF.";
      button.disabled = false; button.textContent = "Generate incident report PDF";
      return;
    }
    try {
      await downloadResponsePdf(report);
      $("environment-status").textContent = "Response assessment PDF downloaded. It includes the selected region, environmental check, recommended actions, agency roles, and limitations.";
    } catch (error) {
      $("environment-status").textContent = `PDF could not be generated: ${error.message || "start the WakeTrace service and try again."}`;
    } finally { button.disabled = false; button.textContent = "Generate incident report PDF"; }
  });

  $("prepare-notice").addEventListener("click", () => {
    const names = [...document.querySelectorAll(".agency-row input:checked")].map((box) => box.closest(".agency-row").querySelector("b").textContent);
    const box = $("notification-preview");
    box.innerHTML = "";
    const dot = document.createElement("span"); dot.className = "preview-dot";
    const content = document.createElement("div");
    const title = document.createElement("b"); title.textContent = names.length ? `Draft exercise notice · ${names.length} selected organization${names.length === 1 ? "" : "s"}` : "No organizations selected";
    const desc = document.createElement("small");
    desc.textContent = names.length ? `To: ${names.join(" · ")}. Subject: Illustrative oil-spill response coordination exercise. This preview is local only; no notification was sent.` : "Select one or more organizations before preparing this preview.";
    content.append(title, desc); box.append(dot, content);
  });

  $("live-toggle").addEventListener("click", () => {
    const panel = $("live-panel");
    panel.hidden = !panel.hidden;
    $("live-toggle").setAttribute("aria-expanded", String(!panel.hidden));
    $("live-toggle").lastElementChild.textContent = panel.hidden ? "＋" : "−";
  });
  $("load-live-case").addEventListener("click", async () => {
    const verify = $("case-verify-status");
    const caseId = $("live-case").value.trim();
    if (!caseId) { verify.textContent = "Enter the ID of a saved real-data case first."; return; }
    const button = $("load-live-case"); button.disabled = true; button.textContent = "Verifying case…";
    try {
      const response = await fetch(`http://127.0.0.1:8002/api/cases/${encodeURIComponent(caseId)}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || `Case service returned ${response.status}.`);
      if (data.synthetic === true || !data.detection || !data.case_id) throw new Error("This case is synthetic or has no reviewed detection. Live notifications are blocked.");
      loadedLiveCase = data.case_id;
      demoMode = false;
      analysisContext = {
        synthetic: false,
        caseId: data.case_id,
        candidateCount: data.detection?.candidates?.length || 0,
        originEstimate: Boolean(data.drift?.origin_zone),
        vesselLeadCount: (data.vessel_candidates || []).length,
        detectedRegions: (data.detection?.candidates || []).slice(0, 10).filter((candidate) => candidate.geometry).map((candidate, index) => ({
          label: `Possible feature ${index + 1}`,
          geometry: candidate.geometry,
          pixelCount: candidate.pixel_count,
          screeningScore: candidate.screening_score,
          contrastDb: candidate.contrast_from_scene_median_db,
        })),
      };
      $("mode-label").textContent = "LIVE CASE · REVIEW REQUIRED";
      $("case-label").textContent = `${data.case_id} · real-data review loaded`;
      $("analysis-title").textContent = "Saved real-data review";
      $("analysis-source-badge").textContent = "REAL REVIEW · NOT CONFIRMED";
      $("hero-description").textContent = "A saved real-data case is loaded. This page provides planning prompts only; the response engine does not score this live case.";
      $("jurisdiction-copy").textContent = "Confirm the competent authority and incident area for this case. The Indian organizations listed below are illustrative examples and must not be treated as recipients unless they are the proper verified authority.";
      renderAnalysisSummary();
      initializeRegions();
      updateEngine();
      $("map-caption").textContent = "A saved real-data case is loaded. Select a detected candidate to view its geometry and assess its environmental context.";
      $("advance-hour").disabled = !selectedRegion;
      verify.textContent = `Verified case record ${data.case_id} is loaded. Confirm jurisdiction and recipients before sending.`;
    } catch (error) {
      loadedLiveCase = null;
      verify.textContent = `Live mode not enabled: ${error.message || "case service unavailable"}`;
    } finally { button.disabled = false; button.textContent = "Verify saved case and switch to live"; }
  });
  $("send-live").addEventListener("click", async () => {
    const status = $("live-status");
    const recipients = $("live-recipients").value.split(/[;,\n]/).map((v) => v.trim()).filter(Boolean);
    const caseId = $("live-case").value.trim();
    const jurisdiction = $("live-jurisdiction").value.trim();
    const summary = $("live-summary").value.trim();
    const approver = $("live-approver").value.trim();
    const approvalToken = $("live-approval-code").value;
    if (demoMode || !loadedLiveCase || caseId !== loadedLiveCase) { status.textContent = "Blocked: load the saved real case first. Demo scenarios cannot send notifications."; return; }
    if (!jurisdiction || summary.length < 20 || !approver || !approvalToken || recipients.length === 0 || !$("live-confirm").checked) {
      status.textContent = "Complete the verified jurisdiction, notice summary, allowlisted recipients, approver, approval code, and send confirmation first."; return;
    }
    if (recipients.length > 20) { status.textContent = "Choose no more than 20 approved recipients per notice."; return; }
    const button = $("send-live"); button.disabled = true; button.textContent = "Checking delivery settings…";
    status.textContent = "Submitting an approved send request to the local WakeTrace service…";
    try {
      const response = await fetch("http://127.0.0.1:8002/api/notifications/send", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          demo_mode: false, case_id: caseId, jurisdiction, summary, recipients,
          authorized_approver: approver, approval_token: approvalToken, jurisdiction_confirmed: true,
          confirmation_phrase: "SEND",
          response_report: buildReportObject(),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || `Delivery service returned ${response.status}.`);
      status.textContent = `Accepted by the configured mail service for ${data.sent_count} approved recipient(s). Reference: ${data.notification_id}.`;
    } catch (error) {
      status.textContent = `Not sent: ${error.message || "delivery service unavailable"} No successful delivery is claimed.`;
    } finally { button.disabled = false; button.textContent = "Send approved notification"; }
  });
})();
