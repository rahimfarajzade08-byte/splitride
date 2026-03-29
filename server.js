const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const { createServer } = require("http");
const { Server } = require("socket.io");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const rides = new Map();
const passengersBySocket = new Map();
const driverBySocket = new Map();
const liveTimers = new Map();

const seededPassengers = [
  { id: "seed-1", name: "Aysel", pickup: [49.8156, 40.3777], destination: [49.8920, 40.3770] },
  { id: "seed-2", name: "Murad", pickup: [49.8506, 40.4093], destination: [49.8920, 40.3770] },
  { id: "seed-3", name: "Nigar", pickup: [49.9289, 40.3947], destination: [49.8920, 40.3770] },
  { id: "seed-4", name: "Elvin", pickup: [49.8678, 40.4432], destination: [49.8920, 40.3770] }
];

const azPlaces = readAzPlaces();
const surgeZones = [
  {
    name: "City Center Surge",
    multiplier: 1.18,
    polygon: [
      [49.8205, 40.3565],
      [49.876, 40.3565],
      [49.876, 40.3895],
      [49.8205, 40.3895],
      [49.8205, 40.3565]
    ]
  },
  {
    name: "Airport Corridor Surge",
    multiplier: 1.12,
    polygon: [
      [49.935, 40.435],
      [50.065, 40.435],
      [50.065, 40.49],
      [49.935, 40.49],
      [49.935, 40.435]
    ]
  },
  {
    name: "North Residential Surge",
    multiplier: 1.1,
    polygon: [
      [49.79, 40.41],
      [49.89, 40.41],
      [49.89, 40.47],
      [49.79, 40.47],
      [49.79, 40.41]
    ]
  }
];

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "SplitRide API" });
});

app.get("/api/geocode/reverse", async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: "lat and lng are required numbers" });
  }

  try {
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lng));
    url.searchParams.set("format", "jsonv2");
    const response = await fetch(url, {
      headers: {
        "User-Agent": "SplitRide/1.0 (demo app)",
        "Accept-Language": "az,en;q=0.8"
      }
    });
    const data = await response.json();
    return res.json({
      address: data.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`
    });
  } catch (error) {
    return res.status(502).json({ error: "Reverse geocoding unavailable" });
  }
});

app.get("/api/geocode/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q || q.length < 2) {
    return res.json([]);
  }

  const queryNorm = normalizeText(q);
  const localMatches = azPlaces
    .filter((place) => {
      const text = normalizeText(place.displayName);
      return text.includes(` ${queryNorm}`) || text.startsWith(queryNorm);
    })
    .slice(0, 6);

  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", q);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "6");
    url.searchParams.set("countrycodes", "az");
    url.searchParams.set("viewbox", "49.75,40.50,50.05,40.30");
    url.searchParams.set("bounded", "1");
    const response = await fetch(url, {
      headers: {
        "User-Agent": "SplitRide/1.0 (demo app)",
        "Accept-Language": "az,en;q=0.8"
      }
    });
    const data = await response.json();
    const remoteResults = Array.isArray(data)
      ? data.map((item) => ({
          displayName: item.display_name,
          lat: Number(item.lat),
          lng: Number(item.lon)
        }))
      : [];

    const remoteClean = remoteResults.filter(
      (item) => Number.isFinite(item.lat) && Number.isFinite(item.lng)
    );
    const dedup = new Map();
    [...localMatches, ...remoteClean].forEach((item) => {
      const key = normalizeText(item.displayName);
      if (!dedup.has(key)) dedup.set(key, item);
    });
    return res.json([...dedup.values()].slice(0, 8));
  } catch {
    return res.json(localMatches);
  }
});

app.get("/api/routes", async (req, res) => {
  const coordsParam = String(req.query.coords || "");
  if (!coordsParam) {
    return res.status(400).json({ error: "coords query is required" });
  }

  const coords = coordsParam
    .split(";")
    .map((pair) => pair.split(",").map(Number))
    .filter((pair) => pair.length === 2 && Number.isFinite(pair[0]) && Number.isFinite(pair[1]));

  if (coords.length < 2) {
    return res.status(400).json({ error: "At least 2 coordinates are required" });
  }

  try {
    const routeCoords = coords.map(([lng, lat]) => `${lng},${lat}`).join(";");
    const url = `https://router.project-osrm.org/route/v1/driving/${routeCoords}?overview=full&geometries=geojson`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "SplitRide/1.0 (demo app)"
      }
    });
    const data = await response.json();
    if (!data.routes || !data.routes[0]) {
      return res.status(404).json({ error: "No route found" });
    }
    const route = data.routes[0];
    return res.json({
      coordinates: route.geometry.coordinates,
      distanceMeters: route.distance,
      durationSeconds: route.duration
    });
  } catch (error) {
    return res.status(502).json({ error: "Routing unavailable" });
  }
});

app.post("/api/rides/request", async (req, res) => {
  const { passengerName, pickup, destination, passengerSocketId } = req.body || {};
  if (!isCoord(pickup) || !isCoord(destination)) {
    return res.status(400).json({ error: "pickup and destination coordinates are required" });
  }

  const rider = {
    id: `rider-${Date.now()}`,
    name: passengerName || "Passenger",
    pickup,
    destination
  };

  const matched = seededPassengers
    .filter((p) => haversineKm(p.destination, destination) < 4)
    .slice(0, 2);
  const passengers = [rider, ...matched];
  const pickupSequence = buildPickupSequence(passengers);

  let route = await getRouteFromOsrm([...pickupSequence, destination]);
  if (!route) {
    route = fallbackRoute([...pickupSequence, destination]);
  }

  const fareDetails = await estimateFareDetailed({
    distanceKm: route.distanceKm,
    durationSec: route.durationSec,
    routeCoords: route.coordinates
  });
  const totalFare = fareDetails.totalFare;
  const splitFare = totalFare / passengers.length;

  const rideId = `ride-${Date.now()}`;
  const ride = {
    id: rideId,
    status: "open",
    createdAt: Date.now(),
    passengerSocketId: passengerSocketId || null,
    driverSocketId: null,
    passengers,
    pickupSequence,
    destination,
    routeCoords: route.coordinates,
    distanceKm: route.distanceKm,
    durationSec: route.durationSec,
    totalFare,
    splitFare,
    fareDetails,
    driverPosition: pickupSequence[0]
  };
  rides.set(rideId, ride);

  io.emit("ride:request:new", rideSummary(ride));
  return res.json(ride);
});

app.get("/api/rides/open", (_req, res) => {
  const open = [...rides.values()]
    .filter((ride) => ride.status === "open")
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(rideSummary);
  res.json(open);
});

app.post("/api/rides/:rideId/accept", (req, res) => {
  const ride = rides.get(req.params.rideId);
  if (!ride) return res.status(404).json({ error: "Ride not found" });
  if (ride.status !== "open") return res.status(409).json({ error: "Ride already accepted" });

  ride.status = "accepted";
  ride.driverSocketId = req.body?.driverSocketId || null;
  rides.set(ride.id, ride);

  io.emit("ride:accepted", { rideId: ride.id, status: ride.status });
  startDriverTracking(ride);
  return res.json(ride);
});

app.get("/api/rides/:rideId", (req, res) => {
  const ride = rides.get(req.params.rideId);
  if (!ride) return res.status(404).json({ error: "Ride not found" });
  return res.json(ride);
});

io.on("connection", (socket) => {
  socket.on("register:passenger", () => {
    passengersBySocket.set(socket.id, true);
  });

  socket.on("register:driver", () => {
    driverBySocket.set(socket.id, true);
  });

  socket.on("ride:subscribe", ({ rideId }) => {
    if (rideId) socket.join(`ride:${rideId}`);
  });

  socket.on("disconnect", () => {
    passengersBySocket.delete(socket.id);
    driverBySocket.delete(socket.id);
  });
});

httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`SplitRide server running at http://localhost:${PORT}`);
});

function rideSummary(ride) {
  return {
    id: ride.id,
    status: ride.status,
    passengerCount: ride.passengers.length,
    pickupCount: ride.pickupSequence.length,
    totalFare: ride.totalFare,
    splitFare: ride.splitFare,
    fareDetails: ride.fareDetails || null,
    destination: ride.destination
  };
}

function isCoord(value) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

function buildPickupSequence(passengers) {
  return [...passengers].sort((a, b) => a.pickup[0] - b.pickup[0]).map((p) => p.pickup);
}

async function getRouteFromOsrm(points) {
  try {
    const coords = points.map(([lng, lat]) => `${lng},${lat}`).join(";");
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "SplitRide/1.0 (demo app)"
      }
    });
    const data = await response.json();
    const route = data?.routes?.[0];
    if (!route) return null;
    return {
      coordinates: route.geometry.coordinates,
      distanceKm: route.distance / 1000,
      durationSec: route.duration
    };
  } catch {
    return null;
  }
}

function fallbackRoute(points) {
  let distance = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    distance += haversineKm(points[i], points[i + 1]);
  }
  return { coordinates: points, distanceKm: distance, durationSec: (distance / 24) * 3600 };
}

async function estimateFareDetailed({ distanceKm, durationSec, routeCoords }) {
  const durationMin = Math.max(1, durationSec / 60);
  const avgSpeedKmh = distanceKm / (durationSec / 3600 || 1);
  const mid = midpoint(routeCoords);
  const weather = await fetchWeather(mid[1], mid[0]);

  // Calibrated to match Baku budget ride-hailing ranges more closely.
  const baseFare = 0.55;
  const bookingFee = 0.25;
  const distanceFare = distanceKm * 0.34;
  const timeFare = durationMin * 0.045;
  const subtotal = baseFare + bookingFee + distanceFare + timeFare;

  const peakMultiplier = getPeakMultiplier();
  const trafficMultiplier = getTrafficMultiplier(avgSpeedKmh);
  const weatherMultiplier = getWeatherMultiplier(weather);
  const nightMultiplier = getNightMultiplier();
  const surgeInfo = getSurgeInfo(mid);
  const surgeMultiplier = surgeInfo.multiplier;
  const dynamicMultiplier =
    peakMultiplier * trafficMultiplier * weatherMultiplier * nightMultiplier * surgeMultiplier;

  const totalFare = Math.max(1.9, subtotal * dynamicMultiplier);
  return {
    totalFare: Number(totalFare.toFixed(2)),
    distanceKm: Number(distanceKm.toFixed(2)),
    durationMin: Number(durationMin.toFixed(1)),
    avgSpeedKmh: Number(avgSpeedKmh.toFixed(1)),
    weather,
    components: {
      baseFare: Number(baseFare.toFixed(2)),
      bookingFee: Number(bookingFee.toFixed(2)),
      distanceFare: Number(distanceFare.toFixed(2)),
      timeFare: Number(timeFare.toFixed(2))
    },
    multipliers: {
      peak: peakMultiplier,
      traffic: trafficMultiplier,
      weather: weatherMultiplier,
      night: nightMultiplier,
      surge: surgeMultiplier
    },
    surgeZone: surgeInfo.name
  };
}

function getPeakMultiplier() {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Asia/Baku"
    }).format(new Date())
  );
  if ((hour >= 8 && hour <= 10) || (hour >= 18 && hour <= 21)) return 1.08;
  return 1;
}

function getNightMultiplier() {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Asia/Baku"
    }).format(new Date())
  );
  if (hour >= 0 && hour < 6) return 1.06;
  return 1;
}

function getTrafficMultiplier(avgSpeedKmh) {
  if (avgSpeedKmh < 14) return 1.22;
  if (avgSpeedKmh < 20) return 1.14;
  if (avgSpeedKmh < 28) return 1.07;
  return 1;
}

function getWeatherMultiplier(weather) {
  if (!weather) return 1;
  if (weather.precipitation >= 1.5) return 1.12;
  if (weather.precipitation > 0.1) return 1.06;
  if ([61, 63, 65, 80, 81, 82, 95].includes(weather.weatherCode)) return 1.06;
  return 1;
}

function midpoint(coords) {
  if (!Array.isArray(coords) || !coords.length) return [49.8671, 40.4093];
  const idx = Math.floor(coords.length / 2);
  return coords[idx];
}

async function fetchWeather(lat, lng) {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      "&current=precipitation,weather_code&timezone=auto";
    const response = await fetch(url, {
      headers: { "User-Agent": "SplitRide/1.0 (demo app)" }
    });
    const data = await response.json();
    return {
      precipitation: Number(data?.current?.precipitation || 0),
      weatherCode: Number(data?.current?.weather_code || 0)
    };
  } catch {
    return { precipitation: 0, weatherCode: 0 };
  }
}

function startDriverTracking(ride) {
  const room = `ride:${ride.id}`;
  const coords = ride.routeCoords || [];
  if (coords.length < 2) return;

  if (liveTimers.has(ride.id)) {
    clearInterval(liveTimers.get(ride.id));
    liveTimers.delete(ride.id);
  }

  let segment = 0;
  let progress = 0;
  const timer = setInterval(() => {
    if (segment >= coords.length - 1) {
      io.to(room).emit("ride:completed", { rideId: ride.id });
      io.emit("ride:completed", { rideId: ride.id });
      clearInterval(timer);
      liveTimers.delete(ride.id);
      ride.status = "completed";
      rides.set(ride.id, ride);
      return;
    }

    progress += 0.12;
    const a = coords[segment];
    const b = coords[segment + 1];
    const lng = a[0] + (b[0] - a[0]) * progress;
    const lat = a[1] + (b[1] - a[1]) * progress;
    ride.driverPosition = [lng, lat];
    rides.set(ride.id, ride);

    const payload = { rideId: ride.id, position: ride.driverPosition };
    io.to(room).emit("driver:location", payload);
    io.emit("driver:location", payload);

    if (progress >= 1) {
      progress = 0;
      segment += 1;
    }
  }, 1500);

  liveTimers.set(ride.id, timer);
}

function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
  return 6371 * (2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)));
}

function normalizeText(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[ə]/g, "e")
    .replace(/[ı]/g, "i")
    .replace(/[ö]/g, "o")
    .replace(/[ü]/g, "u")
    .replace(/[ş]/g, "s")
    .replace(/[ç]/g, "c")
    .trim();
}

function getSurgeInfo(point) {
  for (const zone of surgeZones) {
    if (isPointInPolygon(point, zone.polygon)) {
      return { name: zone.name, multiplier: zone.multiplier };
    }
  }
  return { name: "No surge zone", multiplier: 1 };
}

function isPointInPolygon(point, polygon) {
  const x = point[0];
  const y = point[1];
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0];
    const yi = polygon[i][1];
    const xj = polygon[j][0];
    const yj = polygon[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function readAzPlaces() {
  try {
    const filePath = path.join(__dirname, "data", "az-places.json");
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item) =>
          item &&
          typeof item.displayName === "string" &&
          Number.isFinite(item.lng) &&
          Number.isFinite(item.lat)
      )
      .map((item) => ({
        displayName: item.displayName,
        lng: item.lng,
        lat: item.lat,
        city: item.city || "",
        region: item.region || ""
      }));
  } catch {
    return [];
  }
}
