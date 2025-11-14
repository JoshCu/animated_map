import os
from pathlib import Path

import geopandas as gpd
import numpy as np
import xarray as xr
from flask import Flask, jsonify, render_template, request, send_from_directory
from werkzeug.utils import secure_filename


def create_app():
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

    # Ensure upload directory exists
    os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)

    def allowed_file(filename):
        """Check if the file extension is allowed"""
        return os.path.splitext(filename)[1].lower() in app.config["ALLOWED_EXTENSIONS"]

    @app.route("/")
    def index():
        """Serve the main page"""
        return render_template("index.html")

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
        # try:
        # Get resample parameter from query string (in hours)
        resample_hours = request.args.get("resample", default=1, type=int)

        # Get folder path from query parameter, default to current working directory
        data_folder = Path("./uploads")
        nc_file = data_folder / "uploaded.nc"
        gpkg_file = data_folder / "uploaded.gpkg"

        if not data_folder.exists():
            return jsonify({"error": f"Folder not found: {data_folder}"}), 404

        if not gpkg_file.exists():
            return jsonify({"error": f"No GeoPackage file found {gpkg_file}"}), 404

        if not nc_file.exists():
            return jsonify({"error": f"No NetCDF file found {nc_file}"}), 404

        # Read GeoPackage
        gdf = gpd.read_file(gpkg_file, layer="flowpaths")
        if gdf.crs is not None and gdf.crs.to_epsg() != 4326:
            gdf = gdf.to_crs(epsg=4326)

        # Get bounding box and feature IDs (sorted)
        bounds = gdf.total_bounds.tolist()
        feature_ids_gpkg = sorted(gdf["id"].tolist())

        # Read NetCDF
        print(nc_file)
        ds = xr.open_dataset(nc_file)

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
        print(feature_ids_raw)
        print(len(feature_ids_raw))

        # Sort feature IDs and create index mapping using numpy for efficiency

        sort_indices = np.argsort(feature_ids_raw)
        feature_ids_sorted = feature_ids_raw[sort_indices].tolist()

        # Reorder data according to sorted feature IDs
        # Check actual dimension order from xarray
        flow_dims = ds[flow_var].dims
        print(f"DEBUG load_local: flow dimensions: {flow_dims}, shape: {ds[flow_var].shape}")

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
                "geopackage": str(gpkg_file.name),
                "netcdf": str(nc_file.name),
            },
        }

        return jsonify(response)

        # except Exception as e:
        #     return jsonify({"error": f"Error loading local files: {str(e)}"}), 500

    return app


def main():
    """Entry point for the application"""
    app = create_app()
    app.run(debug=True, host="0.0.0.0", port=5000)


if __name__ == "__main__":
    main()
