// Initialize map
let protocol = new pmtiles.Protocol({ metadata: true });
maplibregl.addProtocol("pmtiles", protocol.tile);

const map = new maplibregl.Map({
  container: "map",
  style:
    "https://communityhydrofabric.s3.us-east-1.amazonaws.com/map/styles/light-style.json",
  center: [-96, 40],
  zoom: 4,
});

// Check if data is auto-loaded on startup
map.on("load", async () => {
  try {
    const response = await fetch("/api/config");
    const config = await response.json();
    if (config.auto_loaded) {
      // Data is already loaded, fetch it automatically
      await loadLocalFiles();
    }
  } catch (error) {
    console.error("Error checking auto-load config:", error);
  }
});

// Global variables
let featureIds = [];
let gpkgFilename = null;
let netcdfFilename = null;
let timeSteps = [];
let currentTimeIndex = 0;
let isPlaying = false;
let animationFrame = null;
let flowData = {};
let velocityData = {};
let depthData = {};
let maxFlowValue = 0;
let minFlowValue = Infinity;
let mapBounds = null;
let selectedFlowpathId = null;
let hoverPopup = null;
let hoveredFeatureId = null; // Track which feature is hovered
let timelineResampleInterval = 1;

// File handling
const dropZone = document.getElementById("dropZone");
const fileStatus = document.getElementById("fileStatus");
const loading = document.getElementById("loading");
const errorMessage = document.getElementById("errorMessage");
const timelineContainer = document.getElementById("timelineContainer");
const legend = document.getElementById("legend");
const resetViewButton = document.getElementById("resetViewButton");

// Reset view button handler
resetViewButton.addEventListener("click", resetMapView);

// Load local files button handler
const loadLocalBtn = document.getElementById("loadLocalBtn");
loadLocalBtn.addEventListener("click", (e) => {
  e.stopPropagation(); // Prevent triggering the drop zone click handler
  promptForFolder();
});

// Click handler to open folder dialog
dropZone.addEventListener("click", () => {
  promptForFolder();
});

function promptForFolder() {
  // Create a hidden file input for directory selection
  const input = document.createElement("input");
  input.type = "file";
  input.webkitdirectory = true; // Enable directory selection
  input.directory = true; // Standard attribute (future-proof)

  input.onchange = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length > 0) {
      // Get the folder path from the first file
      // The webkitRelativePath gives us the structure
      const firstFile = files[0];
      const pathParts = firstFile.webkitRelativePath.split("/");

      // Get the root folder name
      const folderName = pathParts[0];

      // We need to get the actual filesystem path
      // Since browsers don't expose full paths for security,
      // we'll need to send the file structure to the server
      await loadLocalFilesFromBrowser(files, folderName);
    }
  };

  input.click();
}

async function loadLocalFilesFromBrowser(files, folderName) {
  loading.classList.add("active");
  fileStatus.innerHTML = "";

  try {
    // Find the geopackage and netcdf files in the file list
    const gpkgFile = files.find(
      (f) =>
        f.webkitRelativePath.includes("/config/") && f.name.endsWith(".gpkg"),
    );

    const ncFiles = files.filter(
      (f) =>
        f.webkitRelativePath.includes("/outputs/troute/") &&
        f.name.startsWith("troute_") &&
        f.name.endsWith(".nc"),
    );

    if (!gpkgFile) {
      throw new Error(`No GeoPackage file found in ${folderName}/config/`);
    }

    if (ncFiles.length === 0) {
      throw new Error(
        `No NetCDF file found matching ${folderName}/outputs/troute/troute_*.nc`,
      );
    }

    // Get the most recent NetCDF file by last modified date
    const ncFile = ncFiles.reduce((latest, current) =>
      current.lastModified > latest.lastModified ? current : latest,
    );

    // Upload files to server
    const formData = new FormData();
    formData.append("gpkg", gpkgFile);
    formData.append("nc", ncFile);
    formData.append("resample", timelineResampleInterval);

    const response = await fetch("/api/upload-and-load", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Failed to load files");
    }

    const data = await response.json();

    // Process and visualize data using unified function
    processDataAndVisualize(data.geopackage, data.netcdf, {
      geopackage: gpkgFile.name,
      netcdf: ncFile.name,
    });
  } catch (error) {
    console.error("Error loading files from folder:", error);
    showError(`Error loading files: ${error.message}`);
  } finally {
    loading.classList.remove("active");
  }
}

async function loadLocalFiles(folderPath = null) {
  loading.classList.add("active");
  fileStatus.innerHTML = "";

  try {
    // Build URL with parameters
    let url = `/api/load-local-files?resample=${timelineResampleInterval}`;
    if (folderPath) {
      url += `&folder=${encodeURIComponent(folderPath)}`;
    }

    const response = await fetch(url);

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Failed to load local files");
    }

    const data = await response.json();

    // Process and visualize data using unified function
    processDataAndVisualize(data.geopackage, data.netcdf, data.files);
  } catch (error) {
    console.error("Error loading local files:", error);
    showError(`Error loading local files: ${error.message}`);
  } finally {
    loading.classList.remove("active");
  }
}

async function fetchGeoPackageData(filename) {
  const response = await fetch(`/api/geopackage/${filename}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to fetch GeoPackage data");
  }

  flowpathsData = await response.json();
  console.log(`Loaded ${flowpathsData.features.length} flowpaths from server`);
  console.log(
    "Sample GeoPackage IDs:",
    flowpathsData.features.slice(0, 5).map((f) => f.properties.id),
  );

  // Zoom to flowpaths immediately after loading
  zoomToFlowpaths();
}

async function fetchNetCDFData(filename) {
  const response = await fetch(
    `/api/netcdf/${filename}?resample=${timelineResampleInterval}`,
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to fetch NetCDF data");
  }

  const data = await response.json();

  // Process the data from the server
  timeSteps = data.time_steps;
  const featureIds = data.feature_ids;
  const flowDataArray = data.flow; // shape: (time, feature_id)
  const velocityDataArray = data.velocity;
  const depthDataArray = data.depth;

  // Organize data by time and feature
  flowData = {};
  velocityData = {};
  depthData = {};
  const numTimes = data.num_times;
  const numFeatures = data.num_features;

  // Reset min/max for color scaling
  maxFlowValue = 0;
  minFlowValue = Infinity;

  for (let t = 0; t < numTimes; t++) {
    flowData[t] = {};
    if (velocityDataArray) velocityData[t] = {};
    if (depthDataArray) depthData[t] = {};

    for (let f = 0; f < numFeatures; f++) {
      const featureId = netcdfFeatureIds[f];

      // Ensure ID has "wb-" prefix to match map layer
      const idStr = String(featureId);
      const flowId = idStr.startsWith("wb-") ? idStr : `wb-${idStr}`;

      // Debug first timestep and first few features
      if (t === 0 && f < 3) {
        console.log(
          `Mapping NetCDF[${t}][${f}]: featureId=${featureId}, flowId=${flowId}, flowValue=${flowDataArray?.[t]?.[f]}`,
        );
      }

      // Safely access data with null checks
      const flowValue =
        (flowDataArray && flowDataArray[t] && flowDataArray[t][f]) || 0;
      flowData[t][flowId] = flowValue;

      if (velocityDataArray && velocityDataArray[t]) {
        velocityData[t][flowId] = velocityDataArray[t][f] || 0;
      }

      if (depthDataArray && depthDataArray[t]) {
        depthData[t][flowId] = depthDataArray[t][f] || 0;
      }

      // Track min/max for color scaling
      if (flowValue > maxFlowValue) maxFlowValue = flowValue;
      if (flowValue < minFlowValue && flowValue > 0) minFlowValue = flowValue;
    }
  }

  console.log(
    `Loaded ${numTimes} time steps with ${numFeatures} features from server (resampled: ${data.resample_hours}h)`,
  );
  console.log(
    `Flow range: ${minFlowValue.toFixed(2)} - ${maxFlowValue.toFixed(2)}`,
  );
  console.log("Sample feature IDs from NetCDF:", featureIds.slice(0, 5));
  console.log(
    "Sample flow data keys at time 0:",
    Object.keys(flowData[0]).slice(0, 5),
  );
}

// Unified function to process NetCDF data and setup visualization
function processDataAndVisualize(geopackageData, netcdfData, fileNames) {
  // Process GeoPackage data (bounds and feature IDs)
  featureIds = geopackageData.feature_ids;
  console.log(`Loaded ${geopackageData.count} flowpaths`);
  console.log("Sample GeoPackage feature IDs:", featureIds.slice(0, 5));

  // Update file status display
  if (fileNames) {
    fileStatus.innerHTML = `<div class="file-loaded">✓ ${fileNames.geopackage}</div>`;
    fileStatus.innerHTML += `<div class="file-loaded">✓ ${fileNames.netcdf}</div>`;
  }

  // Zoom to bounding box
  if (geopackageData.bounds) {
    const [minX, minY, maxX, maxY] = geopackageData.bounds;
    mapBounds = [
      [minX, minY],
      [maxX, maxY],
    ];
    map.fitBounds(mapBounds, { padding: 50, duration: 1000 });
    resetViewButton.style.display = "block";
  }

  // Process NetCDF data
  timeSteps = netcdfData.time_steps;
  const netcdfFeatureIds = netcdfData.feature_ids;
  const flowDataArray = netcdfData.flow;
  const velocityDataArray = netcdfData.velocity;
  const depthDataArray = netcdfData.depth;
  const numTimes = netcdfData.num_times;
  const numFeatures = netcdfData.num_features;

  console.log("Sample NetCDF feature IDs:", netcdfFeatureIds.slice(0, 5));

  // Reset min/max for color scaling
  maxFlowValue = 0;
  minFlowValue = Infinity;
  flowData = {};
  velocityData = {};
  depthData = {};

  for (let t = 0; t < numTimes; t++) {
    flowData[t] = {};
    if (velocityDataArray) velocityData[t] = {};
    if (depthDataArray) depthData[t] = {};

    for (let f = 0; f < numFeatures; f++) {
      const featureId = netcdfFeatureIds[f]; // USE NetCDF IDs, not GeoPackage IDs

      // Ensure ID has "wb-" prefix to match map layer
      const idStr = String(featureId);
      const flowId = idStr.startsWith("wb-") ? idStr : `wb-${idStr}`;

      // Safely access data with null checks
      const flowValue =
        (flowDataArray && flowDataArray[t] && flowDataArray[t][f]) || 0;
      flowData[t][flowId] = flowValue;

      if (velocityDataArray && velocityDataArray[t]) {
        velocityData[t][flowId] = velocityDataArray[t][f] || 0;
      }

      if (depthDataArray && depthDataArray[t]) {
        depthData[t][flowId] = depthDataArray[t][f] || 0;
      }

      // Track min/max for color scaling
      if (flowValue > maxFlowValue) maxFlowValue = flowValue;
      if (flowValue < minFlowValue && flowValue > 0) minFlowValue = flowValue;
    }
  }

  console.log(
    `Loaded ${numTimes} time steps with ${numFeatures} features (resampled: ${netcdfData.resample_hours}h)`,
  );
  console.log(
    `Flow range: ${minFlowValue.toFixed(2)} - ${maxFlowValue.toFixed(2)}`,
  );

  dropZone.classList.add("loaded");

  // Setup visualization
  setupVisualization();
}

function resetMapView() {
  if (mapBounds) {
    map.fitBounds(mapBounds, { padding: 50, duration: 1000 });
  }
}

function setupVisualization() {
  console.log("setupVisualization called", {
    featureIds: featureIds?.length,
    flowDataKeys: Object.keys(flowData).length,
    mapLoaded: map.loaded(),
  });

  if (
    !featureIds ||
    featureIds.length === 0 ||
    Object.keys(flowData).length === 0
  ) {
    console.error("Cannot setup visualization: missing data", {
      featureIds: featureIds?.length,
      flowData: Object.keys(flowData).length,
    });
    return;
  }

  // Setup timeline controls immediately
  setupTimeline();
  legend.classList.add("active");

  // Wait for map and layers to be ready
  const trySetupLayers = () => {
    console.log("trySetupLayers - checking if layers exist", {
      mapLoaded: map.loaded(),
      hasSelectedFlowpaths: !!map.getLayer("selected-flowpaths"),
      hasSelectedCatchments: !!map.getLayer("selected-catchments"),
    });

    if (map.loaded() && map.getLayer("selected-flowpaths")) {
      console.log("Map and layers ready, calling setupLayerFilters");
      setupLayerFilters();
    } else {
      console.log("Layers not ready yet, retrying in 100ms");
      setTimeout(trySetupLayers, 100);
    }
  };

  // Start checking
  trySetupLayers();
}

function setupLayerFilters() {
  console.log("Setting up layer filters for", featureIds.length, "features");

  // Dim the background flowpaths layer first
  if (map.getLayer("flowpaths")) {
    map.setPaintProperty("flowpaths", "line-opacity", 0.1);
  }

  // Set filter on selected-flowpaths layer to show our loaded features
  if (map.getLayer("selected-flowpaths")) {
    // Build filter expression for flowpath IDs
    const flowpathFilter = ["in", "id", ...featureIds];
    map.setFilter("selected-flowpaths", flowpathFilter);

    // Make it visible and set initial style
    map.setPaintProperty("selected-flowpaths", "line-opacity", 1.0);

    // Create a wider invisible hit-area layer for easier hovering
    const hitLayerId = "selected-flowpaths-hit";
    if (!map.getLayer(hitLayerId)) {
      // Get the source from the selected-flowpaths layer
      const sourceLayer = map.getLayer("selected-flowpaths");
      map.addLayer(
        {
          id: hitLayerId,
          type: "line",
          source: sourceLayer.source,
          "source-layer": sourceLayer.sourceLayer,
          paint: {
            "line-color": "transparent",
            "line-width": 15, // Wide hit area
            "line-opacity": 0,
          },
        },
        "selected-flowpaths",
      ); // Add below the visible layer
    }

    // Apply same filter to hit area
    map.setFilter(hitLayerId, flowpathFilter);

    // Remove old event handlers to prevent duplicates
    map.off("mousemove", hitLayerId);
    map.off("mouseleave", hitLayerId);
    map.off("click", hitLayerId);

    // Add hover popup handler to the hit area layer
    map.on("mousemove", hitLayerId, (e) => {
      if (e.features.length > 0) {
        map.getCanvas().style.cursor = "pointer";

        const feature = e.features[0];
        const flowpathId = String(feature.properties.id);

        // Create popup if it doesn't exist
        if (!hoverPopup) {
          hoverPopup = new maplibregl.Popup({
            closeButton: false,
            closeOnClick: false,
          });
        }

        // Only update position and create popup if feature changed
        if (hoveredFeatureId !== flowpathId) {
          hoveredFeatureId = flowpathId;
          hoverPopup.setLngLat(e.lngLat).addTo(map);
        }

        // Update popup content for current timestep
        updateHoverPopupContent();
      }
    });

    map.on("mouseleave", hitLayerId, () => {
      map.getCanvas().style.cursor = "";
      hoveredFeatureId = null;
      if (hoverPopup) {
        hoverPopup.remove();
      }
    });

    // Add click handler for time series plot to the hit area
    map.on("click", hitLayerId, (e) => {
      if (e.features.length > 0) {
        const feature = e.features[0];
        selectedFlowpathId = String(feature.properties.id);
        showTimeSeries(selectedFlowpathId);
      }
    });
  }

  // Set filter on selected-catchments layer to show corresponding catchments
  if (map.getLayer("selected-catchments")) {
    // Convert wb-123 to cat-123 for catchment IDs
    const catchmentIds = featureIds.map((id) => id.replace("wb-", "cat-"));
    const catchmentFilter = ["in", "divide_id", ...catchmentIds];
    map.setFilter("selected-catchments", catchmentFilter);

    // Make fill transparent and outline thicker
    map.setPaintProperty(
      "selected-catchments",
      "fill-color",
      "rgba(0, 0, 0, 0)",
    );
    map.setPaintProperty(
      "selected-catchments",
      "fill-outline-color",
      "rgba(238, 51, 119, 1)",
    );
  }

  // Initial visualization update (synchronous, blocking)
  updateVisualization(0);
}

// Update hover popup content for current timestep
function updateHoverPopupContent() {
  if (!hoverPopup || !hoveredFeatureId) return;

  const currentFlowData = flowData[currentTimeIndex];
  const currentVelocityData = velocityData[currentTimeIndex];
  const currentDepthData = depthData[currentTimeIndex];

  const flow = currentFlowData?.[hoveredFeatureId] || 0;
  const velocity = currentVelocityData?.[hoveredFeatureId] || 0;
  const depth = currentDepthData?.[hoveredFeatureId] || 0;

  const popupContent = `
    <div class="popup-content">
      <div class="popup-row">
        <span class="popup-label">ID:</span>
        <span class="popup-value">${hoveredFeatureId}</span>
      </div>
      <div class="popup-row">
        <span class="popup-label">Flow:</span>
        <span class="popup-value">${flow.toFixed(2)} m³/s</span>
      </div>
      <div class="popup-row">
        <span class="popup-label">Velocity:</span>
        <span class="popup-value">${velocity.toFixed(2)} m/s</span>
      </div>
      <div class="popup-row">
        <span class="popup-label">Depth:</span>
        <span class="popup-value">${depth.toFixed(2)} m</span>
      </div>
    </div>
  `;

  hoverPopup.setHTML(popupContent);
}

let timelineInitialized = false;

function setupTimeline() {
  timelineContainer.classList.add("active");

  const playButton = document.getElementById("playButton");
  const timeSlider = document.getElementById("timeSlider");

  timeSlider.max = timeSteps.length - 1;

  // Only add event listeners once
  if (!timelineInitialized) {
    playButton.addEventListener("click", () => {
      if (isPlaying) {
        pauseAnimation();
      } else {
        playAnimation();
      }
    });

    timeSlider.addEventListener("input", (e) => {
      currentTimeIndex = parseInt(e.target.value);
      updateVisualization(currentTimeIndex);
      updateTimeDisplay();

      if (isPlaying) {
        pauseAnimation();
      }
    });

    timelineInitialized = true;
  }

  updateTimeDisplay();
}

function playAnimation() {
  isPlaying = true;
  document.getElementById("playButton").textContent = "⏸ Pause";

  const speed = parseFloat(document.getElementById("speedSelect").value);
  const frameDelay = 100 / speed;

  function animate() {
    if (!isPlaying) return;

    currentTimeIndex++;
    if (currentTimeIndex >= timeSteps.length) {
      currentTimeIndex = 0;
    }

    updateVisualization(currentTimeIndex);
    document.getElementById("timeSlider").value = currentTimeIndex;
    updateTimeDisplay();

    animationFrame = setTimeout(animate, frameDelay);
  }

  animate();
}

function pauseAnimation() {
  isPlaying = false;
  document.getElementById("playButton").textContent = "▶ Play";

  if (animationFrame) {
    clearTimeout(animationFrame);
    animationFrame = null;
  }
}

function updateVisualization(timeIndex) {
  // Silently skip if layer isn't ready yet
  if (!map.getLayer("selected-flowpaths")) {
    return;
  }

  const currentFlowData = flowData[timeIndex];
  if (!currentFlowData) {
    console.error("No flow data for time index:", timeIndex);
    return;
  }

  // Debug first timestep
  if (timeIndex === 0) {
    console.log("updateVisualization - first timestep debug:");
    console.log("  featureIds (first 3):", featureIds.slice(0, 3));
    console.log(
      "  flowData keys (first 3):",
      Object.keys(currentFlowData).slice(0, 3),
    );
    console.log(
      "  Sample values:",
      featureIds.slice(0, 3).map((id) => ({
        id,
        flowValue: currentFlowData[id],
        exists: id in currentFlowData,
      })),
    );
  }

  // Build paint expressions for this timestep
  // These are MapLibre expressions: https://maplibre.org/maplibre-style-spec/expressions/
  const colorExpression = ["case"];
  const widthExpression = ["case"];

  // For each feature, add a condition to the expression
  for (let i = 0; i < featureIds.length; i++) {
    const id = featureIds[i];
    const flowValue = currentFlowData[id] || 0;

    // Add color condition
    colorExpression.push(["==", ["get", "id"], id]);
    colorExpression.push(getColorForFlow(flowValue));

    // Add width condition
    widthExpression.push(["==", ["get", "id"], id]);
    widthExpression.push(getWidthForFlow(flowValue));
  }

  // Default values (fallback)
  colorExpression.push("#3b82f6");
  widthExpression.push(2);

  // Update layer paint properties (blocking, synchronous)
  map.setPaintProperty("selected-flowpaths", "line-color", colorExpression);
  map.setPaintProperty("selected-flowpaths", "line-width", widthExpression);

  // Update hover popup if one is open
  updateHoverPopupContent();
}

// Track which variables are visible
let plotState = {
  flowpathId: null,
  visibleVariables: {
    flow: true,
    velocity: true,
    depth: true,
  },
};

function showTimeSeries(flowpathId) {
  plotState.flowpathId = flowpathId;

  const plotContainer = document.getElementById("plotContainer");
  const plotTitle = document.getElementById("plotTitle");

  updatePlot();

  // Show the plot container
  plotContainer.style.display = "block";
  plotTitle.textContent = `Time Series: ${flowpathId}`;
}

function updatePlot() {
  if (!plotState.flowpathId) return;

  const flowpathId = plotState.flowpathId;

  // Prepare time series data - use backend-resampled data directly
  const flowValues = [];
  const velocityValues = [];
  const depthValues = [];

  for (let t = 0; t < timeSteps.length; t++) {
    flowValues.push(flowData[t][flowpathId] || 0);

    if (velocityData[t]) {
      velocityValues.push(velocityData[t][flowpathId] || 0);
    }

    if (depthData[t]) {
      depthValues.push(depthData[t][flowpathId] || 0);
    }
  }

  // Use actual timestamps for x-axis
  const times = timeSteps;

  // Create Plotly traces based on visible variables
  const traces = [];

  if (plotState.visibleVariables.flow) {
    traces.push({
      x: times,
      y: flowValues,
      name: "Flow (m³/s)",
      type: "scatter",
      mode: "lines",
      line: { color: "#3b82f6", width: 2 },
    });
  }

  if (plotState.visibleVariables.velocity && velocityValues.length > 0) {
    traces.push({
      x: times,
      y: velocityValues,
      name: "Velocity (m/s)",
      type: "scatter",
      mode: "lines",
      line: { color: "#10b981", width: 2 },
      yaxis: "y2",
    });
  }

  if (plotState.visibleVariables.depth && depthValues.length > 0) {
    traces.push({
      x: times,
      y: depthValues,
      name: "Depth (m)",
      type: "scatter",
      mode: "lines",
      line: { color: "#f59e0b", width: 2 },
      yaxis: "y3",
    });
  }

  const layout = {
    title: "",
    xaxis: {
      title: "Time",
      type: "date",
    },
    yaxis: {
      title: "Flow (m³/s)",
      titlefont: { color: "#3b82f6" },
      tickfont: { color: "#3b82f6" },
    },
    margin: { l: 60, r: 60, t: 20, b: 40 },
    showlegend: true,
    legend: { x: 0.1, y: 1.1, orientation: "h" },
  };

  // Add secondary and tertiary y-axes if needed
  if (plotState.visibleVariables.velocity && velocityValues.length > 0) {
    layout.yaxis2 = {
      title: "Velocity (m/s)",
      titlefont: { color: "#10b981" },
      tickfont: { color: "#10b981" },
      overlaying: "y",
      side: "right",
    };
  }

  if (plotState.visibleVariables.depth && depthValues.length > 0) {
    layout.yaxis3 = {
      title: "Depth (m)",
      titlefont: { color: "#f59e0b" },
      tickfont: { color: "#f59e0b" },
      overlaying: "y",
      side: "right",
      position: 0.95,
    };
  }

  Plotly.newPlot("timeSeries", traces, layout, { responsive: true });
}

// Minimize plot button handler
document.getElementById("minimizePlot").addEventListener("click", () => {
  const plotContainer = document.getElementById("plotContainer");
  const minimizeBtn = document.getElementById("minimizePlot");

  if (plotContainer.classList.contains("minimized")) {
    plotContainer.classList.remove("minimized");
    minimizeBtn.textContent = "−";
  } else {
    plotContainer.classList.add("minimized");
    minimizeBtn.textContent = "+";
  }
});

// Close plot button handler
document.getElementById("closePlot").addEventListener("click", () => {
  const plotContainer = document.getElementById("plotContainer");
  plotContainer.style.display = "none";
  plotContainer.classList.remove("minimized");
  document.getElementById("minimizePlot").textContent = "−";
  selectedFlowpathId = null;
  plotState.flowpathId = null;
});

// Toggle button handlers
document.getElementById("toggleFlow").addEventListener("click", function () {
  plotState.visibleVariables.flow = !plotState.visibleVariables.flow;
  this.classList.toggle("active");
  updatePlot();
});

document
  .getElementById("toggleVelocity")
  .addEventListener("click", function () {
    plotState.visibleVariables.velocity = !plotState.visibleVariables.velocity;
    this.classList.toggle("active");
    updatePlot();
  });

document.getElementById("toggleDepth").addEventListener("click", function () {
  plotState.visibleVariables.depth = !plotState.visibleVariables.depth;
  this.classList.toggle("active");
  updatePlot();
});

// Timeline resample dropdown handler
const timelineResampleSelect = document.getElementById(
  "timelineResampleSelect",
);
const timelineCustomResampleInput = document.getElementById(
  "timelineCustomResample",
);

console.log("Timeline resample elements:", {
  select: timelineResampleSelect,
  input: timelineCustomResampleInput,
});

if (timelineResampleSelect) {
  timelineResampleSelect.addEventListener("change", function () {
    console.log("Timeline resample changed to:", this.value);
    if (this.value === "custom") {
      if (timelineCustomResampleInput) {
        timelineCustomResampleInput.style.display = "inline-block";
        timelineCustomResampleInput.focus();
      }
    } else {
      if (timelineCustomResampleInput) {
        timelineCustomResampleInput.style.display = "none";
      }
      timelineResampleInterval = parseInt(this.value);
      console.log("Applying timeline resample:", timelineResampleInterval);
      applyTimelineResample();
    }
  });
} else {
  console.error("timelineResampleSelect element not found!");
}

if (timelineCustomResampleInput) {
  timelineCustomResampleInput.addEventListener("change", function () {
    const value = parseInt(this.value);
    if (value && value > 0) {
      timelineResampleInterval = value;
      applyTimelineResample();
    }
  });
}

async function applyTimelineResample() {
  // Pause animation if playing
  if (isPlaying) {
    pauseAnimation();
  }

  // Store current time position as percentage
  const currentProgress =
    timeSteps.length > 0 ? currentTimeIndex / timeSteps.length : 0;

  // Show loading indicator
  loading.classList.add("active");
  fileStatus.innerHTML =
    '<div style="color: #3b82f6;">Resampling data...</div>';

  try {
    // Reload data from server with new resample interval
    // This will call processDataAndVisualize which handles everything
    await loadLocalFiles();

    // Restore approximate time position after data is loaded
    if (timeSteps.length > 0) {
      currentTimeIndex = Math.floor(currentProgress * timeSteps.length);
      currentTimeIndex = Math.max(
        0,
        Math.min(currentTimeIndex, timeSteps.length - 1),
      );
      document.getElementById("timeSlider").max = timeSteps.length - 1;
      document.getElementById("timeSlider").value = currentTimeIndex;
      updateTimeDisplay();

      // Update visualization at the restored time index
      // Wait a bit to ensure map layer is ready
      setTimeout(() => {
        if (map.getLayer("selected-flowpaths")) {
          updateVisualization(currentTimeIndex);
        }
      }, 100);

      // If a plot is open, update it with the new data
      if (
        plotState.flowpathId &&
        document.getElementById("plotContainer").style.display === "block"
      ) {
        updatePlot();
      }
    }
  } catch (error) {
    console.error("Error resampling timeline:", error);
    showError(`Error resampling: ${error.message}`);
  } finally {
    loading.classList.remove("active");
  }
}

function getColorForFlow(value) {
  if (value <= 0) return "#94a3b8";

  const normalized =
    (Math.log(value + 1) - Math.log(minFlowValue + 1)) /
    (Math.log(maxFlowValue + 1) - Math.log(minFlowValue + 1));

  const colors = [
    { pos: 0, r: 59, g: 130, b: 246 },
    { pos: 0.25, r: 6, g: 182, b: 212 },
    { pos: 0.5, r: 16, g: 185, b: 129 },
    { pos: 0.75, r: 245, g: 158, b: 11 },
    { pos: 1, r: 239, g: 68, b: 68 },
  ];

  let color1, color2;
  for (let i = 0; i < colors.length - 1; i++) {
    if (normalized >= colors[i].pos && normalized <= colors[i + 1].pos) {
      color1 = colors[i];
      color2 = colors[i + 1];
      break;
    }
  }

  if (!color1) {
    color1 = colors[0];
    color2 = colors[1];
  }

  const range = color2.pos - color1.pos;
  const factor = (normalized - color1.pos) / range;

  const r = Math.round(color1.r + (color2.r - color1.r) * factor);
  const g = Math.round(color1.g + (color2.g - color1.g) * factor);
  const b = Math.round(color1.b + (color2.b - color1.b) * factor);

  return `rgb(${r}, ${g}, ${b})`;
}

function getWidthForFlow(value) {
  if (value <= 0) return 1;

  const normalized =
    (Math.log(value + 1) - Math.log(minFlowValue + 1)) /
    (Math.log(maxFlowValue + 1) - Math.log(minFlowValue + 1));

  return 1 + normalized * 7;
}

function animateFlowPulse(timeIndex) {
  const opacity = 0.6 + 0.4 * Math.sin(timeIndex * 0.1);
  map.setPaintProperty("flowpaths-animation", "line-opacity", opacity);
}

function updateTimeDisplay() {
  const timeStepDisplay = document.getElementById("timeStep");
  const timeDateDisplay = document.getElementById("timeDate");

  if (timeSteps.length > 0) {
    // Update step counter
    timeStepDisplay.textContent = `Step ${currentTimeIndex + 1} / ${timeSteps.length}`;

    // Format and display date/time
    const currentTimeString = timeSteps[currentTimeIndex];
    if (currentTimeString) {
      // Parse the ISO datetime string
      const date = new Date(currentTimeString);

      // Format as: "YYYY-MM-DD HH:MM"
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      const hours = String(date.getHours()).padStart(2, "0");
      const minutes = String(date.getMinutes()).padStart(2, "0");

      timeDateDisplay.textContent = `${year}-${month}-${day} ${hours}:${minutes}`;
    }
  }
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.classList.add("active");
  setTimeout(() => {
    errorMessage.classList.remove("active");
  }, 5000);
}
