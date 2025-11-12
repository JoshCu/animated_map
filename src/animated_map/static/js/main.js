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

// Global variables
let flowpathsData = null;
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

    // Update file status display
    fileStatus.innerHTML = `<div class="file-loaded">✓ ${gpkgFile.name}</div>`;
    fileStatus.innerHTML += `<div class="file-loaded">✓ ${ncFile.name}</div>`;

    // Process GeoPackage data
    flowpathsData = data.geopackage;
    console.log(
      `Loaded ${flowpathsData.features.length} flowpaths from folder`,
    );

    // Zoom to flowpaths
    zoomToFlowpaths();

    // Process NetCDF data
    const netcdfData = data.netcdf;
    timeSteps = netcdfData.time_steps;
    const featureIds = netcdfData.feature_ids;
    const flowDataArray = netcdfData.flow;
    const velocityDataArray = netcdfData.velocity;
    const depthDataArray = netcdfData.depth;

    // Organize data by time and feature
    timeSteps = netcdfData.time_steps;
    flowData = {};
    velocityData = {};
    depthData = {};
    const numTimes = netcdfData.num_times;
    const numFeatures = netcdfData.num_features;

    // Reset min/max for color scaling
    maxFlowValue = 0;
    minFlowValue = Infinity;

    for (let t = 0; t < numTimes; t++) {
      flowData[t] = {};
      if (velocityDataArray) velocityData[t] = {};
      if (depthDataArray) depthData[t] = {};

      for (let f = 0; f < numFeatures; f++) {
        const featureId = featureIds[f];

        // Ensure ID has "wb-" prefix to match GeoPackage
        const idStr = String(featureId);
        const flowId = idStr.startsWith("wb-") ? idStr : `wb-${idStr}`;

        const flowValue = flowDataArray[t][f];
        flowData[t][flowId] = flowValue;

        if (velocityDataArray) {
          velocityData[t][flowId] = velocityDataArray[t][f];
        }

        if (depthDataArray) {
          depthData[t][flowId] = depthDataArray[t][f];
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

    // Update file status display
    fileStatus.innerHTML = `<div class="file-loaded">✓ ${data.files.geopackage}</div>`;
    fileStatus.innerHTML += `<div class="file-loaded">✓ ${data.files.netcdf}</div>`;

    // Process GeoPackage data
    flowpathsData = data.geopackage;
    console.log(
      `Loaded ${flowpathsData.features.length} flowpaths from local file`,
    );
    console.log(
      "Sample GeoPackage IDs:",
      flowpathsData.features.slice(0, 5).map((f) => f.properties.id),
    );

    // Zoom to flowpaths immediately after loading
    zoomToFlowpaths();

    // Process NetCDF data
    const netcdfData = data.netcdf;
    timeSteps = netcdfData.time_steps;
    const featureIds = netcdfData.feature_ids;
    const flowDataArray = netcdfData.flow;
    const velocityDataArray = netcdfData.velocity;
    const depthDataArray = netcdfData.depth;

    // Organize data by time and feature
    timeSteps = netcdfData.time_steps;
    flowData = {};
    velocityData = {};
    depthData = {};
    const numTimes = netcdfData.num_times;
    const numFeatures = netcdfData.num_features;

    // Reset min/max for color scaling
    maxFlowValue = 0;
    minFlowValue = Infinity;

    for (let t = 0; t < numTimes; t++) {
      flowData[t] = {};
      if (velocityDataArray) velocityData[t] = {};
      if (depthDataArray) depthData[t] = {};

      for (let f = 0; f < numFeatures; f++) {
        const featureId = featureIds[f];

        // Ensure ID has "wb-" prefix to match GeoPackage
        const idStr = String(featureId);
        const flowId = idStr.startsWith("wb-") ? idStr : `wb-${idStr}`;

        const flowValue = flowDataArray[t][f];
        flowData[t][flowId] = flowValue;

        if (velocityDataArray) {
          velocityData[t][flowId] = velocityDataArray[t][f];
        }

        if (depthDataArray) {
          depthData[t][flowId] = depthDataArray[t][f];
        }

        // Track min/max for color scaling
        if (flowValue > maxFlowValue) maxFlowValue = flowValue;
        if (flowValue < minFlowValue && flowValue > 0) minFlowValue = flowValue;
      }
    }

    console.log(
      `Loaded ${numTimes} time steps with ${numFeatures} features from local file (resampled: ${netcdfData.resample_hours}h)`,
    );
    console.log(
      `Flow range: ${minFlowValue.toFixed(2)} - ${maxFlowValue.toFixed(2)}`,
    );

    dropZone.classList.add("loaded");

    // Setup visualization
    setupVisualization();
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
      const featureId = featureIds[f];

      // Ensure ID has "wb-" prefix to match GeoPackage
      const idStr = String(featureId);
      const flowId = idStr.startsWith("wb-") ? idStr : `wb-${idStr}`;

      const flowValue = flowDataArray[t][f];
      flowData[t][flowId] = flowValue;

      if (velocityDataArray) {
        velocityData[t][flowId] = velocityDataArray[t][f];
      }

      if (depthDataArray) {
        depthData[t][flowId] = depthDataArray[t][f];
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

function zoomToFlowpaths() {
  if (!flowpathsData || flowpathsData.features.length === 0) return;

  const bounds = new maplibregl.LngLatBounds();
  flowpathsData.features.forEach((feature) => {
    const geom = feature.geometry;
    if (geom.type === "LineString") {
      geom.coordinates.forEach((coord) => {
        bounds.extend(coord);
      });
    } else if (geom.type === "MultiLineString") {
      geom.coordinates.forEach((line) => {
        line.forEach((coord) => {
          bounds.extend(coord);
        });
      });
    }
  });

  // Save bounds for reset button
  mapBounds = bounds;

  // Show reset view button
  resetViewButton.style.display = "block";

  map.fitBounds(bounds, { padding: 50, duration: 1000 });
}

function resetMapView() {
  if (mapBounds) {
    map.fitBounds(mapBounds, { padding: 50, duration: 1000 });
  }
}

function setupVisualization() {
  if (!flowpathsData || Object.keys(flowData).length === 0) return;

  map.on("load", () => {
    addFlowpathsToMap();
  });

  if (map.loaded()) {
    addFlowpathsToMap();
  }

  setupTimeline();
  legend.classList.add("active");
}

function addFlowpathsToMap() {
  if (map.getSource("flowpaths")) {
    map.removeLayer("flowpaths-animation");
    map.removeSource("flowpaths");
  }

  map.addSource("flowpaths", {
    type: "geojson",
    data: flowpathsData,
  });

  // Dim the background flowpaths layer if it exists
  if (map.getLayer("flowpaths")) {
    map.setPaintProperty("flowpaths", "line-opacity", 0.1);
  }

  // Dim selected layers if they exist
  if (map.getLayer("selected-flowpaths")) {
    map.setPaintProperty("selected-flowpaths", "line-opacity", 0.1);
  }

  // Add the animated layer on top of all existing layers
  // Find the first symbol layer to insert before (ensures lines are below labels)
  const layers = map.getStyle().layers;
  let firstSymbolId;
  for (let i = 0; i < layers.length; i++) {
    if (layers[i].type === "symbol") {
      firstSymbolId = layers[i].id;
      break;
    }
  }

  map.addLayer(
    {
      id: "flowpaths-animation",
      type: "line",
      source: "flowpaths",
      paint: {
        "line-color": "#3b82f6",
        "line-width": 2,
        "line-opacity": 0.8,
      },
    },
    firstSymbolId,
  ); // Insert before the first symbol layer (labels)

  // Add hover popup handler
  map.on("mousemove", "flowpaths-animation", (e) => {
    if (e.features.length > 0) {
      map.getCanvas().style.cursor = "pointer";

      const feature = e.features[0];
      const flowpathId = String(feature.properties.id);
      const currentFlowData = flowData[currentTimeIndex];
      const currentVelocityData = velocityData[currentTimeIndex];
      const currentDepthData = depthData[currentTimeIndex];

      const flow = currentFlowData[flowpathId] || 0;
      const velocity = currentVelocityData
        ? currentVelocityData[flowpathId] || 0
        : 0;
      const depth = currentDepthData ? currentDepthData[flowpathId] || 0 : 0;

      const popupContent = `
        <div class="popup-content">
          <div class="popup-row">
            <span class="popup-label">ID:</span>
            <span class="popup-value">${flowpathId}</span>
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

      if (!hoverPopup) {
        hoverPopup = new maplibregl.Popup({
          closeButton: false,
          closeOnClick: false,
        });
      }

      hoverPopup.setLngLat(e.lngLat).setHTML(popupContent).addTo(map);
    }
  });

  map.on("mouseleave", "flowpaths-animation", () => {
    map.getCanvas().style.cursor = "";
    if (hoverPopup) {
      hoverPopup.remove();
    }
  });

  // Add click handler for time series plot
  map.on("click", "flowpaths-animation", (e) => {
    if (e.features.length > 0) {
      const feature = e.features[0];
      selectedFlowpathId = String(feature.properties.id);
      showTimeSeries(selectedFlowpathId);
    }
  });

  updateVisualization(0);
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
  if (!map.getSource("flowpaths")) {
    console.error("No flowpaths source found");
    return;
  }

  const currentFlowData = flowData[timeIndex];
  if (!currentFlowData) {
    console.error("No flow data for time index:", timeIndex);
    return;
  }

  console.log(
    `Updating visualization for time ${timeIndex}, features:`,
    Object.keys(currentFlowData).length,
  );

  const colorExpression = ["case"];
  const widthExpression = ["case"];

  flowpathsData.features.forEach((feature) => {
    const id = String(feature.properties.id);
    const flowValue = currentFlowData[id] || 0;

    const color = getColorForFlow(flowValue);
    colorExpression.push(["==", ["get", "id"], id]);
    colorExpression.push(color);

    const width = getWidthForFlow(flowValue);
    widthExpression.push(["==", ["get", "id"], id]);
    widthExpression.push(width);
  });

  colorExpression.push("#94a3b8");
  widthExpression.push(1);

  map.setPaintProperty("flowpaths-animation", "line-color", colorExpression);
  map.setPaintProperty("flowpaths-animation", "line-width", widthExpression);
  map.setPaintProperty("flowpaths-animation", "line-opacity", 1.0);
}

// Track which variables are visible and current resample interval
let plotState = {
  flowpathId: null,
  visibleVariables: {
    flow: true,
    velocity: true,
    depth: true,
  },
  resampleInterval: 1,
};

function resampleData(data, interval) {
  if (interval === 1) return data;

  const resampled = [];
  for (let i = 0; i < data.length; i += interval) {
    const slice = data.slice(i, i + interval);
    const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
    resampled.push(avg);
  }
  return resampled;
}

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
  const interval = plotState.resampleInterval;

  // Prepare time series data
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

  // Resample the data
  const resampledFlow = resampleData(flowValues, interval);
  const resampledVelocity =
    velocityValues.length > 0 ? resampleData(velocityValues, interval) : [];
  const resampledDepth =
    depthValues.length > 0 ? resampleData(depthValues, interval) : [];

  // Create time indices for resampled data
  const times = resampledFlow.map((_, idx) => idx * interval);

  // Create Plotly traces based on visible variables
  const traces = [];

  if (plotState.visibleVariables.flow) {
    traces.push({
      x: times,
      y: resampledFlow,
      name: "Flow (m³/s)",
      type: "scatter",
      mode: "lines",
      line: { color: "#3b82f6", width: 2 },
    });
  }

  if (plotState.visibleVariables.velocity && resampledVelocity.length > 0) {
    traces.push({
      x: times,
      y: resampledVelocity,
      name: "Velocity (m/s)",
      type: "scatter",
      mode: "lines",
      line: { color: "#10b981", width: 2 },
      yaxis: "y2",
    });
  }

  if (plotState.visibleVariables.depth && resampledDepth.length > 0) {
    traces.push({
      x: times,
      y: resampledDepth,
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
      title: "Time Step",
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
  if (plotState.visibleVariables.velocity && resampledVelocity.length > 0) {
    layout.yaxis2 = {
      title: "Velocity (m/s)",
      titlefont: { color: "#10b981" },
      tickfont: { color: "#10b981" },
      overlaying: "y",
      side: "right",
    };
  }

  if (plotState.visibleVariables.depth && resampledDepth.length > 0) {
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

// Close plot button handler
document.getElementById("closePlot").addEventListener("click", () => {
  document.getElementById("plotContainer").style.display = "none";
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

// Resample dropdown handler
const resampleSelect = document.getElementById("resampleSelect");
const customResampleInput = document.getElementById("customResample");

resampleSelect.addEventListener("change", function () {
  if (this.value === "custom") {
    customResampleInput.style.display = "inline-block";
    customResampleInput.focus();
  } else {
    customResampleInput.style.display = "none";
    plotState.resampleInterval = parseInt(this.value);
    updatePlot();
  }
});

customResampleInput.addEventListener("change", function () {
  const value = parseInt(this.value);
  if (value && value > 0) {
    plotState.resampleInterval = value;
    updatePlot();
  }
});

// Timeline resample dropdown handler
const timelineResampleSelect = document.getElementById(
  "timelineResampleSelect",
);
const timelineCustomResampleInput = document.getElementById(
  "timelineCustomResample",
);

timelineResampleSelect.addEventListener("change", function () {
  if (this.value === "custom") {
    timelineCustomResampleInput.style.display = "inline-block";
    timelineCustomResampleInput.focus();
  } else {
    timelineCustomResampleInput.style.display = "none";
    timelineResampleInterval = parseInt(this.value);
    applyTimelineResample();
  }
});

timelineCustomResampleInput.addEventListener("change", function () {
  const value = parseInt(this.value);
  if (value && value > 0) {
    timelineResampleInterval = value;
    applyTimelineResample();
  }
});

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

  try {
    // Reload data from server with new resample interval
    await loadLocalFiles();

    // Update timeline controls
    const timeSlider = document.getElementById("timeSlider");
    timeSlider.max = timeSteps.length - 1;

    // Restore approximate time position
    currentTimeIndex = Math.floor(currentProgress * timeSteps.length);
    timeSlider.value = currentTimeIndex;

    // Update visualization
    updateVisualization(currentTimeIndex);
    updateTimeDisplay();
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
