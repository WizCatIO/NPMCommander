// NPM Commander - Renderer Process

let currentProject = null;
let runningScripts = new Set();
let detectedUrl = null;

// Scripts that run once (no stop button needed)
const ONE_SHOT_SCRIPTS = ['build', 'test', 'lint', 'format', 'typecheck', 'clean'];

// ANSI code regex to strip terminal colors
const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function stripAnsi(text) {
    return text.replace(ANSI_REGEX, '');
}

// DOM Elements
const elements = {
    projectName: document.getElementById('projectName'),
    projectPath: document.getElementById('projectPath'),
    console: document.getElementById('console'),
    scriptsBar: document.getElementById('scriptsBar'),
    sidebar: document.getElementById('sidebar'),
    sidebarToggle: document.getElementById('sidebarToggle'),
    depsList: document.getElementById('depsList'),
    devDepsList: document.getElementById('devDepsList'),
    depsStatus: document.getElementById('depsStatus'),
    selectFolderBtn: document.getElementById('selectFolderBtn'),
    openFinderBtn: document.getElementById('openFinderBtn'),
    clearConsoleBtn: document.getElementById('clearConsoleBtn'),
    urlBar: document.getElementById('urlBar'),
    urlText: document.getElementById('urlText'),
    copyUrlBtn: document.getElementById('copyUrlBtn'),
    openUrlBtn: document.getElementById('openUrlBtn'),
    dropOverlay: document.getElementById('dropOverlay'),
    copyConsoleBtn: document.getElementById('copyConsoleBtn')
};

// Initialize
async function init() {
    setupEventListeners();
    setupDragDrop();

    // Load default project path
    const defaultPath = await window.api.getDefaultPath();
    await loadProject(defaultPath);

    // Get running scripts
    const running = await window.api.getRunningScripts();
    running.forEach(s => runningScripts.add(s));
    updateScriptButtons();
}

// Event Listeners
function setupEventListeners() {
    // Sidebar toggle
    elements.sidebarToggle.addEventListener('click', () => {
        elements.sidebar.classList.toggle('collapsed');
    });

    // Select folder
    elements.selectFolderBtn.addEventListener('click', async () => {
        const folder = await window.api.selectFolder();
        if (folder) {
            await loadProject(folder);
        }
    });

    // Open in Finder
    elements.openFinderBtn.addEventListener('click', () => {
        if (currentProject && currentProject.projectPath) {
            window.api.openInFinder(currentProject.projectPath);
        }
    });

    // Clear console
    elements.clearConsoleBtn.addEventListener('click', () => {
        elements.console.innerHTML = '';
        elements.urlBar.style.display = 'none';
        detectedUrl = null;
    });

    // Copy Console
    elements.copyConsoleBtn.addEventListener('click', () => {
        const text = elements.console.innerText;
        navigator.clipboard.writeText(text).then(() => {
            const originalHTML = elements.copyConsoleBtn.innerHTML;
            elements.copyConsoleBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
            `;
            elements.copyConsoleBtn.classList.add('btn-success');

            setTimeout(() => {
                elements.copyConsoleBtn.innerHTML = originalHTML;
                elements.copyConsoleBtn.classList.remove('btn-success');
            }, 1000);
        });
    });

    // Open URL
    elements.openUrlBtn.addEventListener('click', () => {
        if (detectedUrl) {
            window.api.openUrl(detectedUrl);
        }
    });

    // Copy URL
    elements.copyUrlBtn.addEventListener('click', () => {
        if (detectedUrl) {
            navigator.clipboard.writeText(detectedUrl).then(() => {
                elements.copyUrlBtn.innerHTML = `
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                    Copied!
                `;
                setTimeout(() => {
                    elements.copyUrlBtn.innerHTML = `
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                        Copy
                    `;
                }, 2000);
            });
        }
    });

    // Script output
    window.api.onScriptOutput((data) => {
        const cleanText = stripAnsi(data.data);
        appendConsole(cleanText, data.type === 'stderr' ? 'error' : '');
        checkForUrl(cleanText);
    });

    // Script exit
    window.api.onScriptExit((data) => {
        runningScripts.delete(data.script);
        updateScriptButtons();
        const type = data.code === 0 ? 'success' : 'error';
        appendConsole(`\n✓ Script '${data.script}' exited with code ${data.code}\n`, type);
    });
}

// Drag & Drop
function setupDragDrop() {
    document.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    document.addEventListener('dragenter', (e) => {
        e.preventDefault();
        elements.dropOverlay.classList.add('visible');
    });

    document.addEventListener('dragleave', (e) => {
        if (e.target === elements.dropOverlay) {
            elements.dropOverlay.classList.remove('visible');
        }
    });

    document.addEventListener('drop', async (e) => {
        e.preventDefault();
        elements.dropOverlay.classList.remove('visible');

        const files = e.dataTransfer.files;
        if (files.length > 0) {
            const path = files[0].path;
            await loadProject(path);
        }
    });
}

// Load Project
async function loadProject(projectPath) {
    // Clear console and reset state for new project
    elements.console.innerHTML = '';
    elements.urlBar.style.display = 'none';
    detectedUrl = null;

    appendConsole(`→ Loading project from: ${projectPath}\n`, 'info');

    const result = await window.api.loadProject(projectPath);

    if (result.error) {
        appendConsole(`✗ ${result.error}\n`, 'error');
        elements.projectName.textContent = 'No Project';
        elements.projectPath.textContent = projectPath;
        elements.scriptsBar.innerHTML = '<div class="no-scripts">No package.json found</div>';
        // Clear dependencies display
        elements.depsList.innerHTML = '<div class="dep-item"><span class="name" style="color: var(--text-muted);">None</span></div>';
        elements.devDepsList.innerHTML = '<div class="dep-item"><span class="name" style="color: var(--text-muted);">None</span></div>';
        return;
    }

    currentProject = result;

    // Update header
    elements.projectName.textContent = result.name;
    elements.projectPath.textContent = result.projectPath;

    // Update dependencies status
    if (result.nodeModulesInstalled) {
        elements.depsStatus.className = 'deps-status installed';
        elements.depsStatus.innerHTML = '<span class="status-dot"></span><span>All dependencies installed</span>';
    } else {
        elements.depsStatus.className = 'deps-status missing';
        elements.depsStatus.innerHTML = `
      <span class="status-dot"></span>
      <span>Dependencies not installed</span>
      <button class="btn btn-primary" style="margin-left: auto; padding: 6px 12px; font-size: 11px;" onclick="installDependencies()">Install</button>
    `;
    }

    // Render dependencies
    renderDependencies(result.dependencies, elements.depsList);
    renderDependencies(result.devDependencies, elements.devDepsList);

    // Render scripts
    renderScripts(result.scripts);

    appendConsole(`✓ Project loaded: ${result.name} v${result.version}\n`, 'success');
}

// Render Dependencies
function renderDependencies(deps, container) {
    container.innerHTML = '';

    for (const [name, version] of Object.entries(deps)) {
        const item = document.createElement('div');
        item.className = 'dep-item';
        item.innerHTML = `<span class="name">${name}</span><span class="version">${version}</span>`;
        container.appendChild(item);
    }

    if (Object.keys(deps).length === 0) {
        container.innerHTML = '<div class="dep-item"><span class="name" style="color: var(--text-muted);">None</span></div>';
    }
}

// Render Scripts
function renderScripts(scripts) {
    elements.scriptsBar.innerHTML = '';

    if (Object.keys(scripts).length === 0) {
        elements.scriptsBar.innerHTML = '<div class="no-scripts">No scripts defined</div>';
        return;
    }

    for (const [name, cmd] of Object.entries(scripts)) {
        const isRunning = runningScripts.has(name);

        const btn = document.createElement('button');
        btn.className = `script-btn ${isRunning ? 'running' : ''}`;
        btn.dataset.script = name;
        btn.onclick = () => toggleScript(name);
        btn.innerHTML = `
            <span class="icon">${isRunning ? '⬛' : '▶'}</span>
            ${name}
        `;

        elements.scriptsBar.appendChild(btn);
    }
}

// Toggle Script (Run/Stop)
async function toggleScript(name) {
    if (runningScripts.has(name)) {
        await stopScript(name);
    } else {
        await runScript(name);
    }
}

// Run Script
async function runScript(name) {
    appendConsole(`\n▶ Starting: npm run ${name}\n`, 'info');

    const result = await window.api.runScript(currentProject.projectPath, name);

    if (result.error) {
        appendConsole(`✗ ${result.error}\n`, 'error');
        return;
    }

    runningScripts.add(name);
    updateScriptButtons();

    // For preview/dev, check for URL
    if (name === 'preview' || name === 'dev' || name === 'start') {
        // URL will be detected from output
    }
}

// Stop Script
async function stopScript(name) {
    appendConsole(`\n⬛ Stopping: ${name}\n`, 'warning');
    await window.api.stopScript(name);
    runningScripts.delete(name);
    updateScriptButtons();
}

// Install Dependencies
async function installDependencies() {
    appendConsole(`\n📦 Installing dependencies...\n`, 'info');
    const result = await window.api.installDeps(currentProject.projectPath);

    if (result.success) {
        elements.depsStatus.className = 'deps-status installed';
        elements.depsStatus.innerHTML = '<span class="status-dot"></span><span>All dependencies installed</span>';
    }
}

// Update Script Buttons
function updateScriptButtons() {
    document.querySelectorAll('.script-btn').forEach(btn => {
        const script = btn.dataset.script;
        const isRunning = runningScripts.has(script);
        btn.classList.toggle('running', isRunning);
        btn.querySelector('.icon').textContent = isRunning ? '⬛' : '▶';
    });

    // Hide URL bar if no dev/preview/start scripts are running
    const serverScripts = ['dev', 'preview', 'start', 'serve'];
    const anyServerRunning = serverScripts.some(s => runningScripts.has(s));
    if (!anyServerRunning && detectedUrl) {
        elements.urlBar.style.display = 'none';
        detectedUrl = null;
    }
}

// Check for localhost URL in output
function checkForUrl(text) {
    // Match various formats: http://localhost:5173, http://127.0.0.1:5173, etc.
    const patterns = [
        /https?:\/\/localhost:\d+/gi,
        /https?:\/\/127\.0\.0\.1:\d+/gi,
        /https?:\/\/\[?::1\]?:\d+/gi
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match && !detectedUrl) {  // Only trigger once per session
            detectedUrl = match[0];
            elements.urlText.textContent = detectedUrl;
            elements.urlBar.style.display = 'flex';

            // Log a clear message so user sees it
            appendConsole(`\n🚀 Server ready at: ${detectedUrl}\n`, 'success');
            return;
        }
    }
}

// Append to Console
function appendConsole(text, type = '') {
    // Remove welcome message if exists
    const welcome = elements.console.querySelector('.console-welcome');
    if (welcome) welcome.remove();

    const span = document.createElement('span');
    span.className = type;
    span.textContent = text;
    elements.console.appendChild(span);
    elements.console.scrollTop = elements.console.scrollHeight;
}

// Make functions global
window.toggleScript = toggleScript;
window.stopScript = stopScript;
window.installDependencies = installDependencies;

// Start
init();
