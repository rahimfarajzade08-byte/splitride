# SplitRide

Dark-themed carpooling web app with Passenger and Driver modes, with a real backend (REST + WebSocket) and fully free map/routing/geocoding APIs.

## Features

- Passenger flow:
  - Pick pickup and destination directly on the map
  - Submit real ride request to backend
  - Match with same-direction passengers
  - Live driver location updates from server over Socket.IO
  - Fare visibility with total and split amount per passenger
- Driver flow:
  - View real incoming ride requests
  - See all passenger pickup points on map
  - Accept ride and view pickup route order from real routing API
  - View collective fare total
- UI/UX:
  - Modern dark style inspired by ride-hailing apps
  - Purple and white accent system
  - Responsive layout optimized for mobile and iPhone Safari
  - Subtle entrance and interaction animations

## APIs Used (Free)

- **Map rendering:** [MapLibre GL JS](https://maplibre.org/) + OpenStreetMap raster tiles
- **Geocoding:** [Nominatim (OpenStreetMap)](https://nominatim.org/)
- **Routing:** [OSRM public demo server](https://project-osrm.org/)
- **Realtime transport:** Socket.IO on your own backend

## Run

1. Install dependencies:

```bash
npm install
```

2. Start backend + frontend server:

```bash
npm start
```

3. Open [http://localhost:3000](http://localhost:3000)

## Tokens

No Mapbox token is required anymore.

## Notes

- Data is currently in-memory (resets on server restart).
- For production, add persistent storage and authenticated users.
