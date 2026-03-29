const DEFAULT_CENTER = [49.8671, 40.4093];
const maplibregl = window.maplibregl;
const SURGE_SOURCE_ID = "surge-zones-source";

const state = {
  mode: "passenger",
  requests: [],
  currentRide: null,
  driverMarker: null,
  pickupMarker: null,
  destinationMarker: null,
  routeLayerId: "route-line",
  routeSourceId: "route-source",
  passengerMarkers: [],
  activeRideId: null,
  socket: null
};

const refs = {
  passengerModeBtn: document.getElementById("passengerModeBtn"),
  driverModeBtn: document.getElementById("driverModeBtn"),
  panelTitle: document.getElementById("panelTitle"),
  passengerControls: document.getElementById("passengerControls"),
  driverControls: document.getElementById("driverControls"),
  pickupInput: document.getElementById("pickupInput"),
  destinationInput: document.getElementById("destinationInput"),
  pickupSuggestions: document.getElementById("pickupSuggestions"),
  destinationSuggestions: document.getElementById("destinationSuggestions"),
  matchRideBtn: document.getElementById("matchRideBtn"),
  requestsList: document.getElementById("requestsList"),
  acceptRideBtn: document.getElementById("acceptRideBtn"),
  matchedRiders: document.getElementById("matchedRiders"),
  totalFare: document.getElementById("totalFare"),
  splitFare: document.getElementById("splitFare"),
  driverTotalFare: document.getElementById("driverTotalFare"),
  passengerFareBreakdown: document.getElementById("passengerFareBreakdown"),
  driverFareBreakdown: document.getElementById("driverFareBreakdown"),
  mapHint: document.getElementById("mapHint"),
  connectionStatus: document.getElementById("connectionStatus")
};

let map;
bootstrap().catch(() => {
  refs.mapHint.textContent = "App failed to initialize. Please refresh the page.";
});

let pickupDebounceId;
let destinationDebounceId;
const suggestionState = {
  pickup: { items: [], activeIndex: -1 },
  destination: { items: [], activeIndex: -1 }
};

function setMode(mode) {
  state.mode = mode;
  const isPassenger = mode === "passenger";

  refs.passengerModeBtn.classList.toggle("active", isPassenger);
  refs.driverModeBtn.classList.toggle("active", !isPassenger);
  refs.passengerModeBtn.setAttribute("aria-selected", String(isPassenger));
  refs.driverModeBtn.setAttribute("aria-selected", String(!isPassenger));
  refs.passengerControls.classList.toggle("active", isPassenger);
  refs.driverControls.classList.toggle("active", !isPassenger);
  refs.panelTitle.textContent = isPassenger ? "Passenger Dashboard" : "Driver Dashboard";
  refs.mapHint.innerHTML = isPassenger
    ? "Tap the map to set pickup and destination, then <strong>Find Shared Ride</strong>."
    : "Review incoming requests and accept a route to begin pickups.";

  if (!isPassenger) {
    if (state.socket) state.socket.emit("register:driver");
    loadDriverRequests();
  } else {
    if (state.socket) state.socket.emit("register:passenger");
    clearPassengerMarkers();
    renderRideForPassenger(state.currentRide);
  }
}

function bindMapClicks() {
  map.on("click", async (e) => {
  if (state.mode !== "passenger") return;
  if (!state.pickupMarker) {
    state.pickupMarker = addMarker(e.lngLat.toArray(), "#6df2bd");
    refs.pickupInput.value = await reverseGeocode(e.lngLat.toArray());
    refs.mapHint.textContent = "Pickup set. Tap another point for destination.";
    return;
  }

  if (!state.destinationMarker) {
    state.destinationMarker = addMarker(e.lngLat.toArray(), "#ffffff");
    refs.destinationInput.value = await reverseGeocode(e.lngLat.toArray());
    refs.mapHint.textContent = "Destination set. Press Find Shared Ride.";
    return;
  }

  state.pickupMarker.setLngLat(e.lngLat.toArray());
  refs.pickupInput.value = await reverseGeocode(e.lngLat.toArray());
  });
}

function addMarker(coords, color) {
  return new maplibregl.Marker({ color }).setLngLat(coords).addTo(map);
}

function bindAutocomplete() {
  refs.pickupInput.addEventListener("input", () => {
    queueSearch("pickup");
  });

  refs.destinationInput.addEventListener("input", () => {
    queueSearch("destination");
  });

  refs.pickupInput.addEventListener("focus", () => {
    if (refs.pickupSuggestions.children.length) refs.pickupSuggestions.classList.add("show");
  });

  refs.destinationInput.addEventListener("focus", () => {
    if (refs.destinationSuggestions.children.length) refs.destinationSuggestions.classList.add("show");
  });

  refs.pickupInput.addEventListener("keydown", (e) => handleSuggestionKeydown(e, "pickup"));
  refs.destinationInput.addEventListener("keydown", (e) =>
    handleSuggestionKeydown(e, "destination")
  );

  document.addEventListener("click", (e) => {
    const target = e.target;
    if (!target.closest(".field")) {
      clearSuggestions("pickup");
      clearSuggestions("destination");
    }
  });
}

function queueSearch(type) {
  const inputEl = type === "pickup" ? refs.pickupInput : refs.destinationInput;
  const query = inputEl.value.trim();
  if (query.length < 2) {
    clearSuggestions(type);
    return;
  }

  if (type === "pickup") clearTimeout(pickupDebounceId);
  else clearTimeout(destinationDebounceId);

  const run = () => searchPlaces(query, type);
  if (type === "pickup") pickupDebounceId = setTimeout(run, 260);
  else destinationDebounceId = setTimeout(run, 260);
}

async function searchPlaces(query, type) {
  try {
    const res = await fetch(`/api/geocode/search?q=${encodeURIComponent(query)}`);
    const items = await res.json();
    if (!res.ok) throw new Error("search failed");
    renderSuggestions(type, items);
  } catch {
    clearSuggestions(type);
  }
}

function renderSuggestions(type, items) {
  const listEl = type === "pickup" ? refs.pickupSuggestions : refs.destinationSuggestions;
  suggestionState[type].items = items;
  suggestionState[type].activeIndex = -1;
  listEl.innerHTML = "";
  if (!Array.isArray(items) || !items.length) {
    listEl.classList.remove("show");
    return;
  }

  items.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item.displayName;
    li.addEventListener("click", () => selectSuggestion(type, item));
    listEl.appendChild(li);
  });
  listEl.classList.add("show");
}

function clearSuggestions(type) {
  const listEl = type === "pickup" ? refs.pickupSuggestions : refs.destinationSuggestions;
  suggestionState[type].items = [];
  suggestionState[type].activeIndex = -1;
  listEl.innerHTML = "";
  listEl.classList.remove("show");
}

function handleSuggestionKeydown(event, type) {
  const stateForType = suggestionState[type];
  if (!stateForType.items.length) return;

  if (event.key === "ArrowDown") {
    event.preventDefault();
    stateForType.activeIndex = (stateForType.activeIndex + 1) % stateForType.items.length;
    refreshActiveSuggestion(type);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    stateForType.activeIndex =
      (stateForType.activeIndex - 1 + stateForType.items.length) % stateForType.items.length;
    refreshActiveSuggestion(type);
  } else if (event.key === "Enter") {
    if (stateForType.activeIndex < 0) return;
    event.preventDefault();
    selectSuggestion(type, stateForType.items[stateForType.activeIndex]);
  } else if (event.key === "Escape") {
    clearSuggestions(type);
  }
}

function refreshActiveSuggestion(type) {
  const listEl = type === "pickup" ? refs.pickupSuggestions : refs.destinationSuggestions;
  const { activeIndex } = suggestionState[type];
  const children = [...listEl.children];
  children.forEach((child, idx) => {
    child.classList.toggle("active", idx === activeIndex);
  });
  const activeEl = children[activeIndex];
  if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
}

function selectSuggestion(type, item) {
  const coords = [item.lng, item.lat];
  if (type === "pickup") {
    refs.pickupInput.value = item.displayName;
    if (!state.pickupMarker) state.pickupMarker = addMarker(coords, "#6df2bd");
    else state.pickupMarker.setLngLat(coords);
    clearSuggestions("pickup");
    refs.mapHint.textContent = "Pickup selected. Choose destination.";
  } else {
    refs.destinationInput.value = item.displayName;
    if (!state.destinationMarker) state.destinationMarker = addMarker(coords, "#ffffff");
    else state.destinationMarker.setLngLat(coords);
    clearSuggestions("destination");
    refs.mapHint.textContent = "Destination selected. Press Find Shared Ride.";
  }
  map.flyTo({ center: coords, zoom: Math.max(map.getZoom(), 13), duration: 600 });
}

async function loadDriverRequests() {
  try {
    const res = await fetch("/api/rides/open");
    if (!res.ok) throw new Error("failed");
    state.requests = await res.json();
    renderRequests();
  } catch {
    refs.mapHint.textContent = "Could not load incoming ride requests.";
  }
}

function renderRequests() {
  refs.requestsList.innerHTML = "";
  state.requests.forEach((request, idx) => {
    const li = document.createElement("li");
    li.className = "request-item";
    li.innerHTML = `<strong>Trip ${idx + 1}: ${request.passengerCount} passengers</strong>
      <span>Route: ${request.pickupCount} pickups • Est. split ${formatMoney(request.splitFare)}</span>`;
    refs.requestsList.appendChild(li);
  });
  refs.acceptRideBtn.disabled = state.requests.length === 0;
}

async function createPassengerRideRequest() {
  const pickupCoords = state.pickupMarker?.getLngLat().toArray();
  const destinationCoords = state.destinationMarker?.getLngLat().toArray();
  if (!pickupCoords || !destinationCoords) {
    refs.mapHint.textContent = "Select pickup and destination directly on the map first.";
    return;
  }

  try {
    refs.matchRideBtn.disabled = true;
    const payload = {
      passengerName: "You",
      pickup: pickupCoords,
      destination: destinationCoords,
      passengerSocketId: state.socket?.id || null
    };
    const res = await fetch("/api/rides/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const ride = await res.json();
    if (!res.ok) throw new Error(ride.error || "Failed to create ride");

    state.currentRide = ride;
    state.activeRideId = ride.id;
    if (state.socket) state.socket.emit("ride:subscribe", { rideId: ride.id });

    refs.matchedRiders.textContent = String(ride.passengers.length);
    refs.totalFare.textContent = formatMoney(ride.totalFare);
    refs.splitFare.textContent = formatMoney(ride.splitFare);
    refs.passengerFareBreakdown.textContent = renderFareBreakdown(ride.fareDetails);
    refs.mapHint.textContent = "Request submitted. Waiting for a driver to accept.";

    drawRoute(ride.routeCoords);
    renderRideForPassenger(ride);
  } catch (error) {
    refs.mapHint.textContent = error.message || "Failed to request ride.";
  } finally {
    refs.matchRideBtn.disabled = false;
  }
}

async function acceptFirstRideRequest() {
  if (!state.requests.length) return;
  const target = state.requests[0];
  try {
    refs.acceptRideBtn.disabled = true;
    const res = await fetch(`/api/rides/${target.id}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ driverSocketId: state.socket?.id || null })
    });
    const accepted = await res.json();
    if (!res.ok) throw new Error(accepted.error || "Failed to accept ride");

    state.activeRideId = accepted.id;
    if (state.socket) state.socket.emit("ride:subscribe", { rideId: accepted.id });
    refs.driverTotalFare.textContent = formatMoney(accepted.totalFare);
    refs.driverFareBreakdown.textContent = renderFareBreakdown(accepted.fareDetails);
    drawRoute(accepted.routeCoords);
    showPassengerPickups(accepted.passengers);
    refs.mapHint.textContent = "Ride accepted. Live driver tracking started.";
    await loadDriverRequests();
  } catch (error) {
    refs.mapHint.textContent = error.message || "Failed to accept ride.";
  } finally {
    refs.acceptRideBtn.disabled = false;
  }
}

function showPassengerPickups(passengers) {
  clearPassengerMarkers();
  passengers.forEach((p) => {
    const mk = addMarker(p.pickup, "#8f63ff");
    state.passengerMarkers.push(mk);
  });
  if (passengers.length) {
    map.fitBounds(boundsForCoords(passengers.map((p) => p.pickup)), { padding: 65, duration: 600 });
  }
}

function renderRideForPassenger(ride) {
  if (!ride) return;
  const allPoints = ride.passengers.flatMap((p) => [p.pickup, p.destination]);
  map.fitBounds(boundsForCoords(allPoints), { padding: 70, duration: 700 });
}

function drawRoute(coords) {
  if (!coords || !coords.length) return;
  if (!map.getSource(state.routeSourceId)) return;
  map.getSource(state.routeSourceId).setData({
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords }
  });
}

function addSurgeZonesLayer() {
  const sourceData = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "City Center Surge", level: "high" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [49.8205, 40.3565],
              [49.876, 40.3565],
              [49.876, 40.3895],
              [49.8205, 40.3895],
              [49.8205, 40.3565]
            ]
          ]
        }
      },
      {
        type: "Feature",
        properties: { name: "Airport Corridor Surge", level: "medium" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [49.935, 40.435],
              [50.065, 40.435],
              [50.065, 40.49],
              [49.935, 40.49],
              [49.935, 40.435]
            ]
          ]
        }
      },
      {
        type: "Feature",
        properties: { name: "North Residential Surge", level: "low" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [49.79, 40.41],
              [49.89, 40.41],
              [49.89, 40.47],
              [49.79, 40.47],
              [49.79, 40.41]
            ]
          ]
        }
      }
    ]
  };

  if (!map.getSource(SURGE_SOURCE_ID)) {
    map.addSource(SURGE_SOURCE_ID, { type: "geojson", data: sourceData });
  }

  if (!map.getLayer("surge-zones-fill")) {
    map.addLayer({
      id: "surge-zones-fill",
      type: "fill",
      source: SURGE_SOURCE_ID,
      paint: {
        "fill-color": [
          "match",
          ["get", "level"],
          "high",
          "#ff4f9a",
          "medium",
          "#ff8a65",
          "#9f7cff"
        ],
        "fill-opacity": 0.18
      }
    });
  }

  if (!map.getLayer("surge-zones-line")) {
    map.addLayer({
      id: "surge-zones-line",
      type: "line",
      source: SURGE_SOURCE_ID,
      paint: {
        "line-color": "#ffffff",
        "line-width": 1.4,
        "line-opacity": 0.5
      }
    });
  }
}

function updateDriverPosition(position) {
  if (!position) return;
  if (!state.driverMarker) {
    state.driverMarker = addMarker(position, "#ff4fc8");
  } else {
    state.driverMarker.setLngLat(position);
  }
}

function formatMoney(value) {
  return new Intl.NumberFormat("az-AZ", { style: "currency", currency: "AZN" }).format(value);
}

function renderFareBreakdown(details) {
  if (!details) return "Tarif detalları mövcud deyil.";
  const c = details.components || {};
  const m = details.multipliers || {};
  const rain = details.weather?.precipitation ?? 0;
  return [
    `Baza: ${formatMoney(c.baseFare || 0)}, booking: ${formatMoney(c.bookingFee || 0)}`,
    `Məsafə: ${details.distanceKm} km (${formatMoney(c.distanceFare || 0)})`,
    `Vaxt: ${details.durationMin} dəq (${formatMoney(c.timeFare || 0)})`,
    `Orta sürət: ${details.avgSpeedKmh} km/saat`,
    `Əmsallar -> pik:${m.peak || 1} tıxac:${m.traffic || 1} hava:${m.weather || 1} gecə:${m.night || 1} surge:${m.surge || 1}`,
    `Surge zona: ${details.surgeZone || "No surge zone"}`,
    `Yağıntı: ${rain} mm`
  ].join(" | ");
}

function emptyLineString() {
  return { type: "Feature", geometry: { type: "LineString", coordinates: [] } };
}

function boundsForCoords(coords) {
  const b = new maplibregl.LngLatBounds(coords[0], coords[0]);
  coords.forEach((c) => b.extend(c));
  return b;
}

function clearPassengerMarkers() {
  state.passengerMarkers.forEach((m) => m.remove());
  state.passengerMarkers = [];
}

async function reverseGeocode(coords) {
  try {
    const [lng, lat] = coords;
    const url = `/api/geocode/reverse?lat=${lat}&lng=${lng}`;
    const res = await fetch(url);
    const data = await res.json();
    return data?.address || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  } catch {
    return `${coords[1].toFixed(4)}, ${coords[0].toFixed(4)}`;
  }
}

function setupSocketHandlers() {
  state.socket = io();
  state.socket.emit("register:passenger");
  refs.connectionStatus.textContent = "Connected";

  state.socket.on("connect", () => {
    refs.connectionStatus.textContent = "Connected";
    state.socket.emit(state.mode === "driver" ? "register:driver" : "register:passenger");
    if (state.activeRideId) state.socket.emit("ride:subscribe", { rideId: state.activeRideId });
  });

  state.socket.on("disconnect", () => {
    refs.connectionStatus.textContent = "Offline";
  });

  state.socket.on("ride:request:new", () => {
    if (state.mode === "driver") loadDriverRequests();
  });

  state.socket.on("ride:accepted", async ({ rideId }) => {
    if (state.activeRideId === rideId && state.mode === "passenger") {
      refs.mapHint.textContent = "Driver accepted your ride. Live location is now updating.";
    }
    if (state.mode === "driver") await loadDriverRequests();
  });

  state.socket.on("driver:location", ({ rideId, position }) => {
    if (rideId !== state.activeRideId) return;
    updateDriverPosition(position);
  });

  state.socket.on("ride:completed", ({ rideId }) => {
    if (rideId !== state.activeRideId) return;
    refs.mapHint.textContent = "Ride completed.";
  });
}

async function bootstrap() {
  map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "© OpenStreetMap contributors"
        }
      },
      layers: [
        {
          id: "osm-tiles",
          type: "raster",
          source: "osm",
          minzoom: 0,
          maxzoom: 19
        }
      ]
    },
    center: DEFAULT_CENTER,
    zoom: 11.8,
    pitch: 30
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

  map.on("load", () => {
    map.addSource(state.routeSourceId, {
      type: "geojson",
      data: emptyLineString()
    });

    map.addLayer({
      id: state.routeLayerId,
      type: "line",
      source: state.routeSourceId,
      paint: {
        "line-color": "#8f63ff",
        "line-width": 5,
        "line-opacity": 0.9
      }
    });
    addSurgeZonesLayer();
  });

  refs.passengerModeBtn.addEventListener("click", () => setMode("passenger"));
  refs.driverModeBtn.addEventListener("click", () => setMode("driver"));
  refs.matchRideBtn.addEventListener("click", () => createPassengerRideRequest());
  refs.acceptRideBtn.addEventListener("click", () => acceptFirstRideRequest());

  bindMapClicks();
  bindAutocomplete();
  setupSocketHandlers();
  setMode("passenger");
}
