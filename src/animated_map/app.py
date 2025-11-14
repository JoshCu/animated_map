import argparse
import logging
import os
import sys
import time
from pathlib import Path

import geopandas as gpd
import numpy as np
import xarray as xr
from flask import Flask, jsonify, render_template, request, send_from_directory
from flask_compress import Compress
from werkzeug.utils import secure_filename

# Configure logging
logging.basicConfig(level=logging.DEBUG, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


def create_app(data_folder=None):
    """Application factory for creating Flask app instance"""
    # Determine the package directory
    package_dir = Path(__file__).parent

    # Create Flask app with correct template and static folders
    app = Flask(
        __name__,
        template_folder=str(package_dir / "templates"),
        static_folder=str(package_dir / "static"),
    )

    # Configuration
    app.config["UPLOAD_FOLDER"] = "uploads"
    app.config["MAX_CONTENT_LENGTH"] = 500 * 1024 * 1024  # 500MB max file size
    app.config["ALLOWED_EXTENSIONS"] = {".gpkg", ".nc"}
    app.config["AUTO_LOADED"] = False

    # Enable compression for all responses
    app.config["COMPRESS_MIMETYPES"] = [
        "text/html",
        "text/css",
        "text/javascript",
        "application/json",
        "application/javascript",
    ]
    app.config["COMPRESS_LEVEL"] = 6  # Balance between speed and compression ratio (1-9)
    app.config["COMPRESS_MIN_SIZE"] = 500  # Only compress responses larger than 500 bytes

    # Initialize compression
    Compress(app)
    logger.info("Flask-Compress enabled with gzip compression")

    # Ensure upload directory exists
    uploads_path = Path(app.config["UPLOAD_FOLDER"])
    uploads_path.mkdir(exist_ok=True)

    # If data folder is provided, symlink files into uploads
    if data_folder:
        data_path = Path(data_folder).resolve()
        if not data_path.exists():
            print(f"Error: Data folder does not exist: {data_folder}", file=sys.stderr)
            sys.exit(1)

        # Clear existing files in uploads folder
        for file_path in uploads_path.iterdir():
            if file_path.is_file() or file_path.is_symlink():
                file_path.unlink()

        # Find GeoPackage file in config/
        gpkg_files = list((data_path / "config").glob("*.gpkg"))
        if not gpkg_files:
            print(f"Error: No .gpkg file found in {data_path / 'config'}", file=sys.stderr)
            sys.exit(1)
        gpkg_source = gpkg_files[0]

        # Find NetCDF file in outputs/troute/
        nc_files = list((data_path / "outputs" / "troute").glob("troute_*.nc"))
        if not nc_files:
            print(f"Error: No troute_*.nc file found in {data_path / 'outputs' / 'troute'}", file=sys.stderr)
            sys.exit(1)
        # Get the most recent NetCDF file
        nc_source = max(nc_files, key=lambda p: p.stat().st_mtime)

        # Create symlinks
        gpkg_link = uploads_path / "uploaded.gpkg"
        nc_link = uploads_path / "uploaded.nc"

        gpkg_link.symlink_to(gpkg_source.resolve())
        nc_link.symlink_to(nc_source.resolve())

        print(f"Linked {gpkg_source} -> {gpkg_link}")
        print(f"Linked {nc_source} -> {nc_link}")

        app.config["AUTO_LOADED"] = True

    def allowed_file(filename):
        """Check if the file extension is allowed"""
        return os.path.splitext(filename)[1].lower() in app.config["ALLOWED_EXTENSIONS"]

    @app.route("/")
    def index():
        """Serve the main page"""
        return render_template("index.html", auto_loaded=app.config["AUTO_LOADED"])

    @app.route("/api/config")
    def get_config():
        """Return app configuration for frontend"""
        return jsonify({"auto_loaded": app.config["AUTO_LOADED"]})

    @app.route("/upload", methods=["POST"])
    def upload_file():
        """Handle file uploads"""
        if "files" not in request.files:
            return jsonify({"error": "No files provided"}), 400

        files = request.files.getlist("files")

        if len(files) == 0:
            return jsonify({"error": "No files selected"}), 400

        uploaded_files = []

        for file in files:
            if file and allowed_file(file.filename):
                filename = secure_filename(file.filename)
                filepath = os.path.join(app.config["UPLOAD_FOLDER"], filename)
                file.save(filepath)
                uploaded_files.append({"filename": filename, "size": os.path.getsize(filepath)})
            else:
                return jsonify({"error": f"Invalid file type: {file.filename}"}), 400

        return jsonify({"message": "Files uploaded successfully", "files": uploaded_files})

    @app.route("/uploads/<filename>")
    def uploaded_file(filename):
        """Serve uploaded files"""
        return send_from_directory(app.config["UPLOAD_FOLDER"], filename)

    @app.route("/health")
    def health():
        """Health check endpoint"""
        return jsonify({"status": "ok"})

    @app.route("/api/netcdf/<filename>", methods=["GET"])
    def read_netcdf(filename):
        """Read and process NetCDF file, return JSON data"""
        try:
            filepath = os.path.join(app.config["UPLOAD_FOLDER"], secure_filename(filename))

            if not os.path.exists(filepath):
                return jsonify({"error": "File not found"}), 404

            # Get resample parameter from query string (in hours)
            resample_hours = request.args.get("resample", default=1, type=int)

            # Open NetCDF file with xarray
            ds = xr.open_dataset(filepath)

            # Get time dimension
            if "time" not in ds.dims:
                return jsonify({"error": "Time dimension not found in NetCDF"}), 400

            # Get feature_id dimension
            if "feature_id" not in ds.dims:
                return jsonify({"error": "feature_id dimension not found in NetCDF"}), 400

            # Find flow variable
            flow_var = None
            for var_name in ["flow", "streamflow", "q", "discharge"]:
                if var_name in ds.variables:
                    flow_var = var_name
                    break

            if not flow_var:
                return jsonify({"error": "Flow variable not found"}), 400

            # Apply resampling if requested
            if resample_hours > 1:
                # Resample using xarray's resample method
                freq_str = f"{resample_hours}H"
                ds = ds.resample(time=freq_str).mean()

            # Extract data
            # Note: data is shaped (feature_id, time), need to transpose for (time, feature_id)
            time_data = ds["time"].values
            feature_ids_raw = ds["feature_id"].values

            # Sort feature IDs and create index mapping using numpy for efficiency
            sort_indices = np.argsort(feature_ids_raw)
            feature_ids_sorted = feature_ids_raw[sort_indices].tolist()

            # Reorder data according to sorted feature IDs
            # Check actual dimension order from xarray
            flow_dims = ds[flow_var].dims

            if flow_dims[0] == "feature_id":
                # Shape is (feature_id, time) - need to transpose
                flow_data_sorted = ds[flow_var].values[sort_indices, :]
                flow_transposed = flow_data_sorted.T.tolist()
            else:
                # Shape is (time, feature_id) - already correct order
                flow_data_sorted = ds[flow_var].values[:, sort_indices]
                flow_transposed = flow_data_sorted.tolist()

            # Convert time to ISO format strings
            time_strings = [str(t) for t in time_data]

            # Also get velocity and depth if available, with same sorting
            velocity_transposed = None
            depth_transposed = None

            if "velocity" in ds.variables:
                velocity_dims = ds["velocity"].dims
                if velocity_dims[0] == "feature_id":
                    velocity_data_sorted = ds["velocity"].values[sort_indices, :]
                    velocity_transposed = velocity_data_sorted.T.tolist()
                else:
                    velocity_data_sorted = ds["velocity"].values[:, sort_indices]
                    velocity_transposed = velocity_data_sorted.tolist()

            if "depth" in ds.variables:
                depth_dims = ds["depth"].dims
                if depth_dims[0] == "feature_id":
                    depth_data_sorted = ds["depth"].values[sort_indices, :]
                    depth_transposed = depth_data_sorted.T.tolist()
                else:
                    depth_data_sorted = ds["depth"].values[:, sort_indices]
                    depth_transposed = depth_data_sorted.tolist()

            feature_ids = feature_ids_sorted

            # Close dataset
            ds.close()

            # Format response
            response = {
                "time_steps": time_strings,
                "feature_ids": feature_ids,
                "flow": flow_transposed,  # shape: (time, feature_id)
                "velocity": velocity_transposed,
                "depth": depth_transposed,
                "num_times": len(time_strings),
                "num_features": len(feature_ids),
                "resample_hours": resample_hours,
            }

            return jsonify(response)

        except Exception as e:
            return jsonify({"error": f"Error processing NetCDF file: {str(e)}"}), 500

    @app.route("/api/geopackage/<filename>", methods=["GET"])
    def read_geopackage(filename):
        """Read and process GeoPackage file, return bounding box and feature IDs"""
        try:
            filepath = os.path.join(app.config["UPLOAD_FOLDER"], secure_filename(filename))

            if not os.path.exists(filepath):
                return jsonify({"error": "File not found"}), 404

            # Read GeoPackage with geopandas
            gdf = gpd.read_file(filepath, layer="flowpaths")

            # Reproject to Web Mercator (EPSG:4326 for GeoJSON standard)
            if gdf.crs is not None and gdf.crs.to_epsg() != 4326:
                gdf = gdf.to_crs(epsg=4326)

            # Get bounding box [minx, miny, maxx, maxy]
            bounds = gdf.total_bounds.tolist()

            # Get feature IDs and sort them to ensure consistent ordering
            feature_ids = sorted(gdf["id"].tolist())

            return jsonify({"bounds": bounds, "feature_ids": feature_ids, "count": len(feature_ids)})

        except Exception as e:
            return jsonify({"error": f"Error processing GeoPackage file: {str(e)}"}), 500

    @app.route("/api/upload-and-load", methods=["POST"])
    def upload_and_load():
        """Upload files from browser folder picker and process them"""
        try:
            # Get uploaded files
            if "gpkg" not in request.files or "nc" not in request.files:
                return jsonify({"error": "Missing required files"}), 400

            gpkg_file = request.files["gpkg"]
            nc_file = request.files["nc"]
            resample_hours = int(request.form.get("resample", 1))

            # Clear uploads folder before saving new files
            uploads_dir = Path(app.config["UPLOAD_FOLDER"])
            if uploads_dir.exists():
                # Delete all files in uploads folder
                for file_path in uploads_dir.iterdir():
                    if file_path.name == ".gitkeep":
                        continue
                    if file_path.is_file():
                        file_path.unlink()
            else:
                uploads_dir.mkdir(parents=True, exist_ok=True)

            # Save files to uploads folder
            gpkg_path = uploads_dir / "uploaded.gpkg"
            nc_path = uploads_dir / "uploaded.nc"

            # Save the uploaded file content
            gpkg_file.save(str(gpkg_path))
            nc_file.save(str(nc_path))

            # Process GeoPackage
            gdf = gpd.read_file(gpkg_path, layer="flowpaths")
            if gdf.crs is not None and gdf.crs.to_epsg() != 4326:
                gdf = gdf.to_crs(epsg=4326)

            # Get bounding box and feature IDs (sorted)
            bounds = gdf.total_bounds.tolist()
            feature_ids_gpkg = sorted(gdf["id"].tolist())

            # Process NetCDF
            ds = xr.open_dataset(nc_path)

            if "time" not in ds.dims:
                return jsonify({"error": "Time dimension not found in NetCDF"}), 400

            if "feature_id" not in ds.dims:
                return jsonify({"error": "feature_id dimension not found in NetCDF"}), 400

            # Find flow variable
            flow_var = None
            for var_name in ["flow", "streamflow", "q", "discharge"]:
                if var_name in ds.variables:
                    flow_var = var_name
                    break

            if not flow_var:
                return jsonify({"error": "Flow variable not found"}), 400

            # Apply resampling if requested
            if resample_hours > 1:
                freq_str = f"{resample_hours}H"
                ds = ds.resample(time=freq_str).mean()

            # Extract data
            time_data = ds["time"].values
            feature_ids_raw = ds["feature_id"].values

            # Sort feature IDs and create index mapping using numpy for efficiency
            sort_indices = np.argsort(feature_ids_raw)
            feature_ids_sorted = feature_ids_raw[sort_indices].tolist()

            print(f"DEBUG: feature_ids_raw shape: {feature_ids_raw.shape}")
            print(f"DEBUG: sort_indices shape: {sort_indices.shape}, max: {sort_indices.max()}")

            # Reorder data according to sorted feature IDs
            # Check actual dimension order from xarray
            flow_dims = ds[flow_var].dims
            print(f"DEBUG: flow dimensions: {flow_dims}, shape: {ds[flow_var].shape}")

            if flow_dims[0] == "feature_id":
                # Shape is (feature_id, time) - need to transpose
                flow_data_sorted = ds[flow_var].values[sort_indices, :]
                flow_transposed = flow_data_sorted.T.tolist()
            else:
                # Shape is (time, feature_id) - already correct order
                flow_data_sorted = ds[flow_var].values[:, sort_indices]
                flow_transposed = flow_data_sorted.tolist()

            # Convert time to ISO format strings
            time_strings = [str(t) for t in time_data]

            # Get velocity and depth if available, with same sorting
            velocity_transposed = None
            depth_transposed = None

            if "velocity" in ds.variables:
                velocity_dims = ds["velocity"].dims
                if velocity_dims[0] == "feature_id":
                    velocity_data_sorted = ds["velocity"].values[sort_indices, :]
                    velocity_transposed = velocity_data_sorted.T.tolist()
                else:
                    velocity_data_sorted = ds["velocity"].values[:, sort_indices]
                    velocity_transposed = velocity_data_sorted.tolist()

            if "depth" in ds.variables:
                depth_dims = ds["depth"].dims
                if depth_dims[0] == "feature_id":
                    depth_data_sorted = ds["depth"].values[sort_indices, :]
                    depth_transposed = depth_data_sorted.T.tolist()
                else:
                    depth_data_sorted = ds["depth"].values[:, sort_indices]
                    depth_transposed = depth_data_sorted.tolist()

            feature_ids = feature_ids_sorted

            ds.close()

            # Return combined response
            response = {
                "geopackage": {"bounds": bounds, "feature_ids": feature_ids_gpkg, "count": len(feature_ids_gpkg)},
                "netcdf": {
                    "time_steps": time_strings,
                    "feature_ids": feature_ids,
                    "flow": flow_transposed,
                    "velocity": velocity_transposed,
                    "depth": depth_transposed,
                    "num_times": len(time_strings),
                    "num_features": len(feature_ids),
                    "resample_hours": resample_hours,
                },
                "files": {
                    "geopackage": Path(gpkg_file.filename).name,
                    "netcdf": Path(nc_file.filename).name,
                },
            }

            return jsonify(response)

        except Exception as e:
            return jsonify({"error": f"Error processing files: {str(e)}"}), 500

    @app.route("/api/load-local-files", methods=["GET"])
    def load_local_files():
        """Load files from configured local directories"""
        start_time = time.time()
        logger.info("=" * 80)
        logger.info("Starting load_local_files request")

        # Get resample parameter from query string (in hours)
        resample_hours = request.args.get("resample", default=1, type=int)
        logger.info(f"Resample parameter: {resample_hours} hours")

        # Get folder path from query parameter, default to current working directory
        data_folder = Path("./uploads")
        nc_file = data_folder / "uploaded.nc"
        gpkg_file = data_folder / "uploaded.gpkg"

        if not data_folder.exists():
            logger.error(f"Folder not found: {data_folder}")
            return jsonify({"error": f"Folder not found: {data_folder}"}), 404

        if not gpkg_file.exists():
            logger.error(f"No GeoPackage file found: {gpkg_file}")
            return jsonify({"error": f"No GeoPackage file found {gpkg_file}"}), 404

        if not nc_file.exists():
            logger.error(f"No NetCDF file found: {nc_file}")
            return jsonify({"error": f"No NetCDF file found {nc_file}"}), 404

        logger.info(f"Loading GeoPackage: {gpkg_file}")
        gpkg_start = time.time()

        # Read GeoPackage
        gdf = gpd.read_file(gpkg_file, layer="flowpaths")
        logger.info(f"GeoPackage loaded in {time.time() - gpkg_start:.2f}s - {len(gdf)} features")

        reproject_start = time.time()
        if gdf.crs is not None and gdf.crs.to_epsg() != 4326:
            gdf = gdf.to_crs(epsg=4326)
            logger.info(f"Reprojection completed in {time.time() - reproject_start:.2f}s")

        # Get bounding box and feature IDs (sorted)
        bounds = gdf.total_bounds.tolist()
        feature_ids_gpkg = sorted(gdf["id"].tolist())
        logger.info(f"Processed {len(feature_ids_gpkg)} feature IDs from GeoPackage")

        # Read NetCDF
        logger.info(f"Loading NetCDF: {nc_file}")
        nc_start = time.time()
        ds = xr.open_dataset(nc_file)
        logger.info(f"NetCDF opened in {time.time() - nc_start:.2f}s")
        logger.info(f"NetCDF dimensions: {dict(ds.dims)}")
        logger.info(f"NetCDF variables: {list(ds.variables.keys())}")

        if "time" not in ds.dims:
            logger.error("Time dimension not found in NetCDF")
            return jsonify({"error": "Time dimension not found in NetCDF"}), 400

        if "feature_id" not in ds.dims:
            logger.error("feature_id dimension not found in NetCDF")
            return jsonify({"error": "feature_id dimension not found in NetCDF"}), 400

        # Find flow variable
        flow_var = None
        for var_name in ["flow", "streamflow", "q", "discharge"]:
            if var_name in ds.variables:
                flow_var = var_name
                break

        if not flow_var:
            logger.error("Flow variable not found in NetCDF")
            return jsonify({"error": "Flow variable not found"}), 400

        logger.info(f"Using flow variable: {flow_var}")

        # Apply resampling if requested
        if resample_hours > 1:
            logger.info(f"Starting resample to {resample_hours}H")
            resample_start = time.time()
            freq_str = f"{resample_hours}H"
            ds = ds.resample(time=freq_str).mean().compute()
            logger.info(f"Resampling completed in {time.time() - resample_start:.2f}s")
            logger.info(f"New dimensions after resample: {dict(ds.dims)}")

        # Extract data
        logger.info("Extracting time and feature_id data")
        extract_start = time.time()
        time_data = ds["time"].values
        feature_ids_raw = ds["feature_id"].values
        logger.info(
            f"Extracted {len(time_data)} time steps and {len(feature_ids_raw)} feature IDs in {time.time() - extract_start:.2f}s"
        )

        # Sort feature IDs and create index mapping using numpy for efficiency
        logger.info("Sorting feature IDs")
        sort_start = time.time()
        sort_indices = np.argsort(feature_ids_raw)
        feature_ids_sorted = feature_ids_raw[sort_indices].tolist()
        logger.info(f"Feature ID sorting completed in {time.time() - sort_start:.2f}s")

        # Reorder data according to sorted feature IDs
        # Check actual dimension order from xarray
        flow_dims = ds[flow_var].dims
        logger.info(f"Flow variable dimensions: {flow_dims}, shape: {ds[flow_var].shape}")

        logger.info("Extracting and reordering flow data")
        flow_start = time.time()
        if flow_dims[0] == "feature_id":
            # Shape is (feature_id, time) - need to transpose
            flow_data_sorted = ds[flow_var].values[sort_indices, :]
            flow_transposed = flow_data_sorted.T.tolist()
        else:
            # Shape is (time, feature_id) - already correct order
            flow_data_sorted = ds[flow_var].values[:, sort_indices]
            flow_transposed = flow_data_sorted.tolist()
        logger.info(f"Flow data extraction and conversion to list completed in {time.time() - flow_start:.2f}s")

        # Convert time to ISO format strings
        logger.info("Converting time data to ISO strings")
        time_start = time.time()
        time_strings = [str(t) for t in time_data]
        logger.info(f"Time conversion completed in {time.time() - time_start:.2f}s")

        # Get velocity and depth if available, with same sorting
        velocity_transposed = None
        depth_transposed = None

        if "velocity" in ds.variables:
            logger.info("Extracting velocity data")
            velocity_start = time.time()
            velocity_dims = ds["velocity"].dims
            if velocity_dims[0] == "feature_id":
                velocity_data_sorted = ds["velocity"].values[sort_indices, :]
                velocity_transposed = velocity_data_sorted.T.tolist()
            else:
                velocity_data_sorted = ds["velocity"].values[:, sort_indices]
                velocity_transposed = velocity_data_sorted.tolist()
            logger.info(f"Velocity data extraction completed in {time.time() - velocity_start:.2f}s")

        if "depth" in ds.variables:
            logger.info("Extracting depth data")
            depth_start = time.time()
            depth_dims = ds["depth"].dims
            if depth_dims[0] == "feature_id":
                depth_data_sorted = ds["depth"].values[sort_indices, :]
                depth_transposed = depth_data_sorted.T.tolist()
            else:
                depth_data_sorted = ds["depth"].values[:, sort_indices]
                depth_transposed = depth_data_sorted.tolist()
            logger.info(f"Depth data extraction completed in {time.time() - depth_start:.2f}s")

        feature_ids = feature_ids_sorted

        ds.close()
        logger.info("NetCDF dataset closed")

        # Return combined response
        logger.info("Building JSON response")
        response_start = time.time()
        response = {
            "geopackage": {"bounds": bounds, "feature_ids": feature_ids_gpkg, "count": len(feature_ids_gpkg)},
            "netcdf": {
                "time_steps": time_strings,
                "feature_ids": feature_ids,
                "flow": flow_transposed,
                "velocity": velocity_transposed,
                "depth": depth_transposed,
                "num_times": len(time_strings),
                "num_features": len(feature_ids),
                "resample_hours": resample_hours,
            },
            "files": {
                "geopackage": str(gpkg_file.name),
                "netcdf": str(nc_file.name),
            },
        }
        logger.info(f"Response built in {time.time() - response_start:.2f}s")

        # Create JSON response
        json_response = jsonify(response)

        # Log response size (before compression)
        import json as json_module

        response_json_str = json_module.dumps(response)
        uncompressed_size = len(response_json_str.encode("utf-8"))
        logger.info(f"Response size (uncompressed): {uncompressed_size / 1024 / 1024:.2f} MB")
        logger.info("Compression enabled: gzip will compress before sending to client")

        total_time = time.time() - start_time
        logger.info(f"TOTAL REQUEST TIME: {total_time:.2f}s")
        logger.info("=" * 80)

        return json_response

    return app


def main():
    """Entry point for the application"""
    parser = argparse.ArgumentParser(description="Animated Streamflow Visualizer")
    parser.add_argument(
        "data_folder",
        nargs="?",
        default=None,
        help="Path to data folder containing config/*.gpkg and outputs/troute/troute_*.nc",
    )
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind to (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=5000, help="Port to bind to (default: 5000)")
    parser.add_argument("--debug", action="store_true", help="Enable debug mode")

    args = parser.parse_args()

    app = create_app(data_folder=args.data_folder)
    app.run(debug=args.debug, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
