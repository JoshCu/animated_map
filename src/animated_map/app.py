import os
from pathlib import Path

import geopandas as gpd
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
            feature_ids = ds["feature_id"].values.tolist()
            flow_data = ds[flow_var].values  # shape: (feature_id, time)

            # Convert time to ISO format strings
            time_strings = [str(t) for t in time_data]

            # Transpose to (time, feature_id) for easier client-side processing
            flow_transposed = flow_data.T.tolist()  # Now shape: (time, feature_id)

            # Also get velocity and depth if available
            velocity_transposed = None
            depth_transposed = None

            if "velocity" in ds.variables:
                velocity_data = ds["velocity"].values
                velocity_transposed = velocity_data.T.tolist()

            if "depth" in ds.variables:
                depth_data = ds["depth"].values
                depth_transposed = depth_data.T.tolist()

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
        """Read and process GeoPackage file, return GeoJSON"""
        try:
            filepath = os.path.join(app.config["UPLOAD_FOLDER"], secure_filename(filename))

            if not os.path.exists(filepath):
                return jsonify({"error": "File not found"}), 404

            # Read GeoPackage with geopandas
            gdf = gpd.read_file(filepath, layer="flowpaths")

            # Reproject to Web Mercator (EPSG:4326 for GeoJSON standard)
            if gdf.crs is not None and gdf.crs.to_epsg() != 4326:
                gdf = gdf.to_crs(epsg=4326)

            # Convert to GeoJSON
            geojson = gdf.__geo_interface__

            return jsonify(geojson)

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
            geojson = gdf.__geo_interface__

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
            feature_ids = ds["feature_id"].values.tolist()
            flow_data = ds[flow_var].values

            # Convert time to ISO format strings
            time_strings = [str(t) for t in time_data]

            flow_transposed = flow_data.T.tolist()

            # Get velocity and depth if available
            velocity_transposed = None
            depth_transposed = None

            if "velocity" in ds.variables:
                velocity_data = ds["velocity"].values
                velocity_transposed = velocity_data.T.tolist()

            if "depth" in ds.variables:
                depth_data = ds["depth"].values
                depth_transposed = depth_data.T.tolist()

            ds.close()

            # Return combined response
            response = {
                "geopackage": geojson,
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
        try:
            # Get resample parameter from query string (in hours)
            resample_hours = request.args.get("resample", default=1, type=int)

            # Get folder path from query parameter, default to current working directory
            folder_path = request.args.get("folder", default=str(Path.cwd()))
            data_folder = Path(folder_path)

            if not data_folder.exists():
                return jsonify({"error": f"Folder not found: {folder_path}"}), 404

            # Look for geopackage in folder/config/*.gpkg
            gpkg_file = None
            config_dir = data_folder / "config"

            if config_dir.exists():
                gpkg_files = list(config_dir.glob("*.gpkg"))
                if gpkg_files:
                    gpkg_file = gpkg_files[0]

            if not gpkg_file or not gpkg_file.exists():
                return jsonify({"error": f"No GeoPackage file found in {config_dir}"}), 404

            # Look for NetCDF in folder/outputs/troute/troute_*.nc
            outputs_dir = data_folder / "outputs" / "troute"
            nc_file = None

            if outputs_dir.exists():
                nc_files = list(outputs_dir.glob("troute_*.nc"))
                if nc_files:
                    # Sort by modification time, get the most recent
                    nc_file = max(nc_files, key=lambda p: p.stat().st_mtime)

            if not nc_file or not nc_file.exists():
                return jsonify(
                    {"error": f"No NetCDF file found matching {outputs_dir}/troute_*.nc"}
                ), 404

            # Read GeoPackage
            gdf = gpd.read_file(gpkg_file, layer="flowpaths")
            if gdf.crs is not None and gdf.crs.to_epsg() != 4326:
                gdf = gdf.to_crs(epsg=4326)
            geojson = gdf.__geo_interface__

            # Read NetCDF
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
            feature_ids = ds["feature_id"].values.tolist()
            flow_data = ds[flow_var].values

            # Convert time to ISO format strings
            time_strings = [str(t) for t in time_data]

            flow_transposed = flow_data.T.tolist()

            # Get velocity and depth if available
            velocity_transposed = None
            depth_transposed = None

            if "velocity" in ds.variables:
                velocity_data = ds["velocity"].values
                velocity_transposed = velocity_data.T.tolist()

            if "depth" in ds.variables:
                depth_data = ds["depth"].values
                depth_transposed = depth_data.T.tolist()

            ds.close()

            # Return combined response
            response = {
                "geopackage": geojson,
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

        except Exception as e:
            return jsonify({"error": f"Error loading local files: {str(e)}"}), 500

    return app


def main():
    """Entry point for the application"""
    app = create_app()
    app.run(debug=True, host="0.0.0.0", port=5000)


if __name__ == "__main__":
    main()
