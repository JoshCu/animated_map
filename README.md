# Animated Streamflow Visualizer

Flask web app for visualizing animated streamflow data with MapLibre GL JS.

## Quick Start

```bash
# Install dependencies
uv sync

# Run the app
uv run anim
```

Open http://localhost:5000 and drag & drop:
- A `.gpkg` file (GeoPackage with flowpath geometries)
- A `.nc` file (NetCDF with streamflow time-series)

## Features

- Interactive map with MapLibre GL JS
- Server-side NetCDF processing with xarray
- Server-side GeoPackage processing with geopandas (auto CRS reprojection)
- Animated timeline with playback controls
- Color-coded flow visualization with logarithmic scaling
- Dimmed display for inactive/low-flow streams
- Reset view button to refocus on area of interest

## Development

```bash
# Add dependencies
uv add package-name

# Run with auto-reload
uv run python src/animated_map/app.py
```

## API Endpoints

- `GET /` - Main application
- `POST /upload` - Upload files
- `GET /api/geopackage/<filename>` - Fetch processed GeoPackage as GeoJSON (with CRS reprojection)
- `GET /api/netcdf/<filename>` - Fetch processed NetCDF data
- `GET /health` - Health check
