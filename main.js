// main.js
require('dotenv').config();
const { app, BrowserWindow, screen, Tray, Menu, ipcMain, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const apiKey = process.env.GIPHY_API_KEY;
let tray = null;
let sourcesWindow = null;
let sources = [];
let workflowStates = new Map(); // Track workflow states

// Data file path
const dataPath = path.join(__dirname, 'sources.json');

async function getRandomGif(tag = 'fail') {
  try {
    const res = await fetch(`https://api.giphy.com/v1/gifs/random?api_key=${apiKey}&tag=${tag}`);
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    
    const json = await res.json();
    const data = json.data;
    const gif = data.images?.downsized_medium;

    if (gif) {
      return {
        url: gif.url,
        width: parseInt(gif.width, 10) || 400,
        height: parseInt(gif.height, 10) || 300,
      };
    }
  } catch (err) {
    console.error('Error fetching gif:', err.message);
  }
  return { url: '', width: 400, height: 300 };
}

function animateWindow(win, startY, endY, duration = 500, onDone) {
  const bounds = win.getBounds();
  const fps = 60;
  const steps = (duration / 1000) * fps;
  let step = 0;

  const interval = setInterval(() => {
    step++;
    const progress = step / steps;
    const newY = startY + (endY - startY) * progress;
    win.setBounds({ ...bounds, y: Math.round(newY) });

    if (step >= steps) {
      clearInterval(interval);
      if (onDone) onDone();
    }
  }, 1000 / fps);
}

function createGifWindow(gifData) {
  const { width = 400, height = 300, url } = gifData;

  const display = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = display.workAreaSize;

  const x = screenWidth - width - 20;
  const yVisible = screenHeight - height - 20;
  const yHidden = screenHeight + 20; // off-screen (below bottom)

  const win = new BrowserWindow({
    width,
    height,
    x,
    y: yHidden, // start hidden
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    transparent: true,
    skipTaskbar: true, // don’t clutter taskbar
    focusable: false, 
    webPreferences: { contextIsolation: true }
  });

  win.loadURL(`data:text/html;charset=utf-8,<html><body style="margin:0; background:transparent; display:flex; align-items:center; justify-content:center;"><img src="${url}" style="max-width:100%; max-height:100%;" /></body></html>`);

  // Slide up once ready
  win.once('ready-to-show', () => {
    animateWindow(win, yHidden, yVisible, 500, () => {
      // Stay for 5s, then slide down
      setTimeout(() => {
        animateWindow(win, yVisible, yHidden, 500, () => {
          win.close();
        });
      }, 5000);
    });
  });
}

app.whenReady().then(() => {
  // Create a tray icon so the app feels "alive" even without windows
  if (process.platform === 'darwin') {
    app.dock.hide();  // prevent showing in the macOS Dock
  }

  try {
    const iconPath = path.join(__dirname, 'icon-tray.png');
    console.log('Loading tray icon from:', iconPath);
    
    // Create a properly sized icon for macOS tray
    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
      throw new Error('Icon image is empty or could not be loaded');
    }
    
    // Resize for tray (macOS prefers 16x16 or 22x22 for tray icons)
    const trayIcon = image.resize({ width: 22, height: 22 });
    trayIcon.setTemplateImage(true); // Makes it adapt to dark/light mode
    
    tray = new Tray(trayIcon);
    tray.setToolTip('FailWhale - CI/CD Notifier');
    console.log('Tray icon created successfully');
  } catch (error) {
    console.error('Failed to create tray icon:', error);
    
    // Create a simple colored square as fallback
    const fallbackIcon = nativeImage.createEmpty();
    // Create a simple 22x22 colored square
    const canvas = { width: 22, height: 22 };
    const buffer = Buffer.alloc(canvas.width * canvas.height * 4);
    // Fill with blue color (RGBA)
    for (let i = 0; i < buffer.length; i += 4) {
      buffer[i] = 0;     // R
      buffer[i + 1] = 122; // G  
      buffer[i + 2] = 255; // B
      buffer[i + 3] = 255; // A
    }
    const fallback = nativeImage.createFromBuffer(buffer, canvas);
    
    tray = new Tray(fallback);
    tray.setToolTip('FailWhale - CI/CD Notifier (Fallback)');
    console.log('Using fallback tray icon');
  }
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Sources', click: () => openSourcesWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
  tray.setToolTip('FailWhale - CI/CD Notifier');
  tray.setContextMenu(contextMenu);

  // Load existing sources
  loadSources();

  // Background interval for monitoring workflows
  setInterval(async () => {
    await checkWorkflows();
  }, 10000); // Check every 30 seconds
});

// Data persistence functions
function loadSources() {
  try {
    if (fs.existsSync(dataPath)) {
      const data = fs.readFileSync(dataPath, 'utf8');
      sources = JSON.parse(data);
      console.log('Loaded sources:', sources);
    }
  } catch (err) {
    console.error('Error loading sources:', err);
    sources = [];
  }
}

function saveSources() {
  try {
    fs.writeFileSync(dataPath, JSON.stringify(sources, null, 2));
    console.log('Sources saved');
  } catch (err) {
    console.error('Error saving sources:', err);
  }
}

// GitHub API functions
function extractRepoInfo(githubUrl) {
  const match = githubUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }
  return null;
}

async function fetchWorkflowRuns(owner, repo, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      
      const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs`;
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'FailWhale-CI-Notifier/1.0'
        }
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        if (response.status === 403) {
          console.warn(`GitHub API rate limited for ${owner}/${repo}. Waiting before retry...`);
          throw new Error(`GitHub API rate limited: ${response.status}`);
        }
        throw new Error(`GitHub API error: ${response.status}`);
      }
      
      const data = await response.json();
      return data.workflow_runs || [];
      
    } catch (err) {
      const isNetworkError = err.code === 'ENOTFOUND' || err.name === 'AbortError' || err.message.includes('fetch failed');
      
      if (attempt === retries) {
        console.error(`Failed to fetch workflows for ${owner}/${repo} after ${retries} attempts:`, err.message);
        return [];
      }
      
      if (isNetworkError) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000); // Exponential backoff, max 30s
        console.warn(`Network error for ${owner}/${repo} (attempt ${attempt}/${retries}). Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        console.error(`Non-network error for ${owner}/${repo}:`, err.message);
        return [];
      }
    }
  }
  return [];
}

// Network connectivity check
async function isNetworkAvailable() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch('https://api.github.com', {
      method: 'HEAD',
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    return response.status < 500; // Accept any non-server error
  } catch {
    return false;
  }
}

// Workflow monitoring
async function checkWorkflows() {
  // Check network connectivity first
  if (!(await isNetworkAvailable())) {
    console.log('Network unavailable, skipping workflow check');
    return;
  }
  
  for (const source of sources) {
    const repoInfo = extractRepoInfo(source.url);
    if (!repoInfo) continue;

    const runs = await fetchWorkflowRuns(repoInfo.owner, repoInfo.repo);
    if (runs.length === 0) continue;

    const latestRun = runs[0];
    const sourceKey = `${repoInfo.owner}/${repoInfo.repo}`;
    const previousState = workflowStates.get(sourceKey);

    // First time seeing this repo
    if (!previousState) {
      workflowStates.set(sourceKey, {
        latestRunId: latestRun.id,
        status: latestRun.status,
        conclusion: latestRun.conclusion
      });
      continue;
    }

    // New workflow run detected
    if (latestRun.id !== previousState.latestRunId) {
      if (latestRun.status !== 'completed') {
        // New workflow started
        const gifData = await getRandomGif('lets get started');
        if (gifData.url) {
          createGifWindow(gifData);
        }
        
        workflowStates.set(sourceKey, {
          latestRunId: latestRun.id,
          status: latestRun.status,
          conclusion: latestRun.conclusion,
          notifiedStart: true
        });
      }
    }
    // Check if previously running workflow completed
    else if (previousState.status !== 'completed' && latestRun.status === 'completed') {
      const tag = latestRun.conclusion === 'success' ? 'success' : 'failure';
      const gifData = await getRandomGif(tag);
      if (gifData.url) {
        createGifWindow(gifData);
      }
      
      workflowStates.set(sourceKey, {
        latestRunId: latestRun.id,
        status: latestRun.status,
        conclusion: latestRun.conclusion
      });
    }
  }
}

// Sources window management
function openSourcesWindow() {
  if (sourcesWindow) {
    sourcesWindow.focus();
    return;
  }

  sourcesWindow = new BrowserWindow({
    width: 600,
    height: 500,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    title: 'FailWhale - Manage Sources'
  });

  sourcesWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(getSourcesHTML())}`);

  sourcesWindow.on('closed', () => {
    sourcesWindow = null;
  });
}

function getSourcesHTML() {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>FailWhale Sources</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          margin: 20px;
          background: #f5f5f5;
        }
        .container {
          max-width: 500px;
          margin: 0 auto;
          background: white;
          padding: 30px;
          border-radius: 10px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
          color: #333;
          text-align: center;
          margin-bottom: 30px;
        }
        .add-source {
          margin-bottom: 30px;
          padding: 20px;
          background: #f8f9fa;
          border-radius: 8px;
        }
        input[type="url"] {
          width: 100%;
          padding: 12px;
          border: 2px solid #ddd;
          border-radius: 6px;
          font-size: 14px;
          margin-bottom: 10px;
          box-sizing: border-box;
        }
        button {
          background: #007AFF;
          color: white;
          border: none;
          padding: 12px 24px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
        }
        button:hover {
          background: #0056CC;
        }
        .sources-list {
          margin-top: 20px;
        }
        .source-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 15px;
          background: #f8f9fa;
          border-radius: 6px;
          margin-bottom: 10px;
        }
        .source-url {
          font-family: monospace;
          color: #666;
          flex: 1;
          margin-right: 10px;
        }
        .delete-btn {
          background: #FF3B30;
          padding: 6px 12px;
          font-size: 12px;
        }
        .delete-btn:hover {
          background: #D70015;
        }
        .empty-state {
          text-align: center;
          color: #666;
          font-style: italic;
          padding: 40px 20px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🐳 FailWhale Sources</h1>
        
        <div class="add-source">
          <input type="url" id="sourceUrl" placeholder="https://github.com/owner/repo" />
          <button onclick="addSource()">Add Source</button>
        </div>
        
        <div class="sources-list">
          <div id="sourcesList"></div>
        </div>
      </div>

      <script>
        const { ipcRenderer } = require('electron');
        
        function renderSources() {
          ipcRenderer.invoke('get-sources').then(sources => {
            const container = document.getElementById('sourcesList');
            
            if (sources.length === 0) {
              container.innerHTML = '<div class="empty-state">No sources added yet. Add a GitHub repository to get started!</div>';
              return;
            }
            
            container.innerHTML = sources.map((source, index) => \`
              <div class="source-item">
                <div class="source-url">\${source.url}</div>
                <button class="delete-btn" onclick="removeSource(\${index})">Remove</button>
              </div>
            \`).join('');
          });
        }
        
        function addSource() {
          const input = document.getElementById('sourceUrl');
          const url = input.value.trim();
          
          if (!url) return;
          
          if (!url.includes('github.com')) {
            alert('Please enter a valid GitHub repository URL');
            return;
          }
          
          ipcRenderer.invoke('add-source', url).then(() => {
            input.value = '';
            renderSources();
          });
        }
        
        function removeSource(index) {
          ipcRenderer.invoke('remove-source', index).then(() => {
            renderSources();
          });
        }
        
        // Handle Enter key
        document.getElementById('sourceUrl').addEventListener('keypress', (e) => {
          if (e.key === 'Enter') {
            addSource();
          }
        });
        
        // Initial render
        renderSources();
      </script>
    </body>
    </html>
  `;
}

// IPC handlers
ipcMain.handle('get-sources', () => sources);

ipcMain.handle('add-source', (event, url) => {
  const repoInfo = extractRepoInfo(url);
  if (!repoInfo) {
    throw new Error('Invalid GitHub URL');
  }
  
  // Check if source already exists
  const exists = sources.some(source => source.url === url);
  if (exists) {
    throw new Error('Source already exists');
  }
  
  sources.push({ url, added: new Date().toISOString() });
  saveSources();
  return true;
});

ipcMain.handle('remove-source', (event, index) => {
  if (index >= 0 && index < sources.length) {
    const removed = sources.splice(index, 1)[0];
    saveSources();
    
    // Clean up workflow state for removed source
    const repoInfo = extractRepoInfo(removed.url);
    if (repoInfo) {
      const sourceKey = `${repoInfo.owner}/${repoInfo.repo}`;
      workflowStates.delete(sourceKey);
    }
  }
  return true;
});

// Prevent app from quitting when all windows are closed
app.on('window-all-closed', (e) => {
  e.preventDefault(); // do nothing, keep app alive
});