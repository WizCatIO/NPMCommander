// NPM Commander - Tauri Frontend
// Uses Tauri's invoke API for backend communication

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';

const appWindow = getCurrentWindow();

let tabs = new Map();
let activeTabId = null;
let nextTabId = 1;
let isInitialStartup = true;

let recentProjects = [];
const MAX_HISTORY = 10;

function loadHistory() {
    try {
        const stored = localStorage.getItem('npm-commander-history');
        if (stored) {
            recentProjects = JSON.parse(stored);
        }
    } catch (e) { }
}

function addToHistory(project) {
    if (!project || !project.projectPath) return;
    const existingIndex = recentProjects.findIndex(p => p.path === project.projectPath);
    if (existingIndex !== -1) {
        recentProjects.splice(existingIndex, 1);
    }
    recentProjects.unshift({ name: project.name, path: project.projectPath });
    if (recentProjects.length > MAX_HISTORY) {
        recentProjects = recentProjects.slice(0, MAX_HISTORY);
    }
    localStorage.setItem('npm-commander-history', JSON.stringify(recentProjects));
}

function renderHistoryMenu() {
    elements.historyList.innerHTML = '';
    if (recentProjects.length === 0) {
        elements.historyList.innerHTML = '<div class="menu-item" style="color: var(--text-muted); pointer-events: none;">No history yet</div>';
        return;
    }
    recentProjects.forEach(proj => {
        const item = document.createElement('div');
        item.className = 'menu-item';
        let subText = proj.closedAt ? `Last closed: ${new Date(proj.closedAt).toLocaleString()}` : 'Currently Open';
        item.innerHTML = `<strong>${proj.name}</strong><br><span style="font-size:10px; opacity:0.7;">${subText}</span>`;
        item.onclick = async () => {
            elements.historyMenu.classList.add('hidden');

            // Check if project is already open in any tab
            for (const [id, tab] of tabs) {
                if (tab.project && tab.project.projectPath === proj.path) {
                    switchTab(id);
                    return;
                }
            }

            const currentTab = getTab();
            if (currentTab && currentTab.project) {
                await createNewTab();
            }
            loadProject(proj.path);
        };
        elements.historyList.appendChild(item);
    });
}

function updateHistoryOnClose(path) {
    if (!path) return;
    const existingIndex = recentProjects.findIndex(p => p.path === path);
    if (existingIndex !== -1) {
        recentProjects[existingIndex].closedAt = new Date().toISOString();
        localStorage.setItem('npm-commander-history', JSON.stringify(recentProjects));
    }
}

// Accessors for current tab
function getTab() { return tabs.get(activeTabId); }
function getConsole() { return getTab()?.consoleEl; }

const DROP_ZONE_HTML = `
    <div class="console-welcome" id="dropZone">
        <div class="drop-icon">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                <path d="M12 11v6"></path>
                <path d="M9 14l3 3 3-3"></path>
            </svg>
        </div>
        <h3>DROP FOLDER HERE</h3>
        <p class="hint">or select a project to get started</p>
    </div>
`;

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
    selectFolderBtnText: document.getElementById('selectFolderBtnText'),
    openFinderBtn: document.getElementById('openFinderBtn'),
    clearProjectBtn: document.getElementById('clearProjectBtn'),
    clearConsoleBtn: document.getElementById('clearConsoleBtn'),
    urlBar: document.getElementById('urlBar'),
    urlText: document.getElementById('urlText'),
    copyUrlBtn: document.getElementById('copyUrlBtn'),
    openUrlBtn: document.getElementById('openUrlBtn'),
    dropOverlay: document.getElementById('dropOverlay'),
    copyErrorsBtn: document.getElementById('copyErrorsBtn'),
    copyAllBtn: document.getElementById('copyAllBtn'),
    killAllPortsBtn: document.getElementById('killAllPortsBtn'),
    contextMenu: document.getElementById('contextMenu'),
    ctxCopyAll: document.getElementById('ctxCopyAll'),
    ctxCopyErrors: document.getElementById('ctxCopyErrors'),
    ctxCopyWarnings: document.getElementById('ctxCopyWarnings'),
    tabsContainer: document.getElementById('tabsContainer'),
    addTabBtn: document.getElementById('addTabBtn'),
    historyBtn: document.getElementById('historyBtn'),
    historyMenu: document.getElementById('historyMenu'),
    historyList: document.getElementById('historyList'),
    consoleContainer: document.getElementById('console').parentElement, // use parent as container

    // Custom Modal Elements
    customModal: document.getElementById('customModal'),
    customModalTitle: document.getElementById('customModalTitle'),
    customModalMessage: document.getElementById('customModalMessage'),
    customModalCancel: document.getElementById('customModalCancel'),
    customModalConfirm: document.getElementById('customModalConfirm')
};

// Custom Confirm Helper
function showCustomConfirm(message, title = 'Confirm') {
    return new Promise((resolve) => {
        elements.customModalTitle.textContent = title;
        elements.customModalMessage.textContent = message;
        elements.customModal.classList.remove('hidden');

        const cleanup = () => {
            elements.customModal.classList.add('hidden');
            elements.customModalCancel.removeEventListener('click', onCancel);
            elements.customModalConfirm.removeEventListener('click', onConfirm);
        };

        const onCancel = () => {
            cleanup();
            resolve(false);
        };

        const onConfirm = () => {
            cleanup();
            resolve(true);
        };

        elements.customModalCancel.addEventListener('click', onCancel);
        elements.customModalConfirm.addEventListener('click', onConfirm);
    });
}

// Initialize
async function init() {
    loadHistory();
    setupManualDrag();
    setupEventListeners();
    setupDragDrop();
    setupContextMenu();

    await setupTauriListeners();
    setupTabs();

    // Remove the static placeholder console so only tab consoles are shown
    if (elements.console) elements.console.remove();

    // Create initial tab
    await createNewTab();
    isInitialStartup = false;
}

// Setup Tauri event listeners
async function setupTauriListeners() {
    // Script output
    await listen('script-output', (event) => {
        const data = event.payload;
        const cleanText = stripAnsi(data.data);
        const targetTabId = data.tab_id;
        const targetTab = tabs.get(targetTabId);

        if (!targetTab) return;

        let type = '';
        if (data.type === 'stderr') {
            if (cleanText.toLowerCase().includes('warning') || cleanText.includes('WARN')) {
                type = 'warning';
            } else {
                type = 'error';
            }
        } else {
            const lower = cleanText.toLowerCase();
            if (lower.includes('error:') || lower.includes('fail') || lower.includes('exception')) {
                type = 'error';
            } else if (lower.includes('warn') || lower.includes('warning:')) {
                type = 'warning';
            }
        }

        appendConsoleTo(targetTab.consoleEl, cleanText, type);
        checkForUrl(cleanText, targetTab);
    });

    // Script exit
    await listen('script-exit', (event) => {
        const data = event.payload;
        const targetTabId = data.tab_id;
        const targetTab = tabs.get(targetTabId);

        if (!targetTab) return;

        targetTab.runningScripts.delete(data.script);
        if (activeTabId === targetTabId) {
            updateScriptButtons();
        }

        const type = data.code === 0 ? 'success' : 'error';
        appendConsoleTo(targetTab.consoleEl, `\n✓ Script '${data.script}' exited with code ${data.code}\n`, type);
    });
}

// Setup Manual Dragging
function setupManualDrag() {
    const dragRegions = [
        document.querySelector('.titlebar-spacer'),
        document.querySelector('.header')
    ];

    dragRegions.forEach(region => {
        if (!region) return;
        region.addEventListener('mousedown', (e) => {
            // Check if the click is on a button or an interactive element
            if (e.target.closest('button') ||
                e.target.closest('.btn') ||
                e.target.closest('.sidebar-toggle') ||
                e.target.closest('input')) {
                return;
            }

            // Start dragging on left click
            if (e.buttons === 1) {
                appWindow.startDragging();
            }
        });
    });
}

// Event Listeners
function setupEventListeners() {
    // Sidebar toggle
    elements.sidebarToggle.addEventListener('click', () => {
        elements.sidebar.classList.toggle('collapsed');
    });

    // Select folder
    elements.selectFolderBtn.addEventListener('click', async () => {
        const folder = await open({
            directory: true,
            multiple: false,
            title: 'Select Project Folder'
        });
        if (folder) {
            await loadProject(folder);
        }
    });

    // Open in Finder
    elements.openFinderBtn.addEventListener('click', async () => {
        const project = getTab()?.project;
        if (project && project.projectPath) {
            try {
                await revealItemInDir(project.projectPath);
            } catch (e) {
                console.error('Failed to open in Finder:', e);
            }
        }
    });

    // Clear Project
    let clearBtnState = 0;
    let clearBtnInterval = null;
    let clearBtnCountdown = 3;

    window.resetClearButton = function () {
        if (clearBtnInterval) clearInterval(clearBtnInterval);
        clearBtnState = 0;
        if (elements.clearProjectBtn) {
            elements.clearProjectBtn.classList.remove('btn-confirming');
            elements.clearProjectBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M18 6L6 18M6 6l12 12"></path>
                </svg>
                Clear Project
            `;
        }
    };

    elements.clearProjectBtn.addEventListener('click', async () => {
        const tab = getTab();
        if (!tab) return;

        if (clearBtnState === 0) {
            clearBtnState = 1;
            clearBtnCountdown = 3;
            elements.clearProjectBtn.classList.add('btn-confirming');
            elements.clearProjectBtn.innerHTML = `Confirm Close (3)`;

            clearBtnInterval = setInterval(() => {
                clearBtnCountdown--;
                if (clearBtnCountdown <= 0) {
                    window.resetClearButton();
                } else {
                    elements.clearProjectBtn.innerHTML = `Confirm Close (${clearBtnCountdown})`;
                }
            }, 1000);
            return;
        }

        if (clearBtnState === 1) {
            window.resetClearButton();
            // Stop any running scripts first
            for (const script of tab.runningScripts) {
                await stopScript(script);
            }

            if (tab.project) {
                updateHistoryOnClose(tab.project.projectPath);
            }
            tab.project = null;
            tab.el.querySelector('.tab-title').textContent = 'New Project';
            elements.projectName.textContent = 'Select a Project';
            elements.projectPath.textContent = 'No project loaded';
            tab.consoleEl.innerHTML = DROP_ZONE_HTML;
            elements.scriptsBar.innerHTML = '<div class="no-scripts">Load a project to see available scripts</div>';
            elements.depsList.innerHTML = '';
            elements.devDepsList.innerHTML = '';
            elements.depsStatus.className = 'deps-status';
            elements.depsStatus.innerHTML = '<span class="status-dot"></span><span>Not loaded</span>';
            elements.clearProjectBtn.classList.add('hidden');
            elements.openFinderBtn.classList.add('hidden');
            if (elements.killAllPortsBtn) elements.killAllPortsBtn.classList.add('hidden');
            elements.selectFolderBtnText.textContent = 'Open Project';
            tab.detectedUrl = null;
            updateScriptButtons();
            elements.urlBar.style.display = 'none';
        }
    });

    // Clear console
    elements.clearConsoleBtn.addEventListener('click', () => {
        const tab = getTab();
        if (tab) {
            tab.consoleEl.innerHTML = '';
            elements.urlBar.style.display = 'none';
            tab.detectedUrl = null;
        }
    });

    // Kill Port 3000
    // Kill All Ports
    if (elements.killAllPortsBtn) {
        elements.killAllPortsBtn.addEventListener('click', async () => {
            const confirmed = await showCustomConfirm('Are you sure you want to kill all processes on ports 3000-3010, 5173, 8000, 8080, 5560, and 8877? This may stop other running applications.', 'Kill All Ports');
            if (!confirmed) {
                return;
            }

            const originalText = elements.killAllPortsBtn.innerHTML;
            elements.killAllPortsBtn.textContent = 'Killing Ports...';
            elements.killAllPortsBtn.disabled = true;

            try {
                const result = await invoke('kill_all_ports');
                appendConsole(`\n⚡ ${result}\n`, 'success');
            } catch (error) {
                const errorMsg = error.error || error.message || String(error);
                appendConsole(`✗ Failed to kill ports: ${errorMsg}\n`, 'error');
            } finally {
                elements.killAllPortsBtn.innerHTML = originalText;
                elements.killAllPortsBtn.disabled = false;
            }
        });
    }

    // Click on Drop Zone to select folder
    document.addEventListener('click', (e) => {
        const dropZone = e.target.closest('#dropZone');
        // Only trigger if in the active console
        if (dropZone && dropZone.closest('.console') === getConsole()) {
            elements.selectFolderBtn.click();
        }
    });

    // Helper for Copy actions
    const copyToClipboard = async (text, btn) => {
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            const originalHTML = btn.innerHTML;
            const originalWidth = btn.offsetWidth;

            btn.classList.add('btn-success');
            btn.textContent = 'Copied!';
            btn.style.width = `${originalWidth}px`; // Prevent layout shift

            setTimeout(() => {
                btn.innerHTML = originalHTML;
                btn.classList.remove('btn-success');
                btn.style.width = '';
            }, 1000);
        } catch (e) {
            console.error('Failed to copy:', e);
        }
    };

    // Copy All
    elements.copyAllBtn.addEventListener('click', () => {
        const cons = getConsole();
        if (cons) copyToClipboard(cons.innerText, elements.copyAllBtn);
    });

    // Copy Errors (Left Click)
    elements.copyErrorsBtn.addEventListener('click', () => {
        const cons = getConsole();
        if (!cons) return;
        const spans = cons.querySelectorAll('.error, .warning');
        const text = Array.from(spans).map(s => s.innerText).join('\n');
        if (text) {
            copyToClipboard(text, elements.copyErrorsBtn);
        } else {
            appendConsoleTo(cons, '\nNo errors or warnings to copy.\n', 'info');
        }
    });

    // Context Menu for Copy Errors
    elements.copyErrorsBtn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY);
    });

    // Open URL
    elements.openUrlBtn.addEventListener('click', async () => {
        const tUrl = getTab()?.detectedUrl;
        if (tUrl) {
            try {
                await openUrl(tUrl);
            } catch (e) {
                console.error('Failed to open URL:', e);
            }
        }
    });

    // Copy URL
    elements.copyUrlBtn.addEventListener('click', async () => {
        const tUrl = getTab()?.detectedUrl;
        if (tUrl) {
            await copyToClipboard(tUrl, elements.copyUrlBtn);
        }
    });

    // Install Dependencies Handler (delegated)
    document.addEventListener('click', (e) => {
        if (e.target.closest('.btn-install-deps')) {
            installDependencies();
        }
    });

    // History button logic
    if (elements.historyBtn && elements.historyMenu) {
        elements.historyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            elements.historyMenu.classList.toggle('hidden');
            renderHistoryMenu();
        });
    }

    // Hide context menu on click elsewhere
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.context-menu')) {
            if (elements.contextMenu) elements.contextMenu.classList.add('hidden');
            if (elements.historyMenu) elements.historyMenu.classList.add('hidden');
        }
    });

    // CMD+W to close tab
    window.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
            e.preventDefault();
            if (activeTabId) {
                closeTab(activeTabId);
            }
        }
    });
}

// Setup Context Menu Actions
function setupContextMenu() {
    elements.ctxCopyAll.addEventListener('click', () => {
        const cons = getConsole();
        if (cons) copyToClipboard(cons.innerText, elements.copyErrorsBtn);
        elements.contextMenu.classList.add('hidden');
    });

    elements.ctxCopyErrors.addEventListener('click', () => {
        const cons = getConsole();
        if (cons) {
            const spans = cons.querySelectorAll('.error');
            const text = Array.from(spans).map(s => s.innerText).join('\n');
            copyToClipboard(text, elements.copyErrorsBtn);
        }
        elements.contextMenu.classList.add('hidden');
    });

    elements.ctxCopyWarnings.addEventListener('click', () => {
        const cons = getConsole();
        if (cons) {
            const spans = cons.querySelectorAll('.warning');
            const text = Array.from(spans).map(s => s.innerText).join('\n');
            copyToClipboard(text, elements.copyErrorsBtn);
        }
        elements.contextMenu.classList.add('hidden');
    });
}

function showContextMenu(x, y) {
    elements.contextMenu.style.left = `${x}px`;
    elements.contextMenu.style.top = `${y}px`;
    elements.contextMenu.classList.remove('hidden');
}

// Drag & Drop
async function setupDragDrop() {
    // In Tauri v2, using onDragDropEvent is the recommended and most robust way
    // to handle native file drops.
    await appWindow.onDragDropEvent((event) => {
        if (event.payload.type === 'enter') {
            elements.dropOverlay.classList.add('visible');
        } else if (event.payload.type === 'drop') {
            elements.dropOverlay.classList.remove('visible');
            const paths = event.payload.paths;
            if (paths && paths.length > 0) {
                // Ensure we call loadProject with the dropped path
                loadProject(paths[0]);
            }
        } else if (event.payload.type === 'leave' || event.payload.type === 'cancelled') {
            elements.dropOverlay.classList.remove('visible');
        }
    });

    // Also prevent default browser behavior for these events to avoid conflicts
    window.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
    }, false);

    window.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
    }, false);
}

// Load Project
async function loadProject(projectPath) {
    const tab = getTab();
    if (!tab) return;

    if (tab.project && tab.project.projectPath !== projectPath) {
        updateHistoryOnClose(tab.project.projectPath);
    }

    // Clear console and reset state for new project
    tab.consoleEl.innerHTML = '';
    elements.urlBar.style.display = 'none';
    tab.detectedUrl = null;

    appendConsoleTo(tab.consoleEl, `→ Loading project from: ${projectPath}\n`, 'info');

    try {
        const result = await invoke('load_project', { path: projectPath });

        tab.project = result;
        addToHistory(result);

        // Update header if active
        if (activeTabId === tab.id) {
            if (window.resetClearButton) window.resetClearButton();
            elements.projectName.textContent = result.name;
            elements.projectPath.textContent = result.projectPath;
        }
        tab.el.querySelector('.tab-title').textContent = result.name;

        // Show project-specific buttons
        elements.clearProjectBtn.classList.remove('hidden');
        elements.openFinderBtn.classList.remove('hidden');
        elements.selectFolderBtnText.textContent = 'Change Project';
        if (elements.killAllPortsBtn) elements.killAllPortsBtn.classList.remove('hidden');

        // Update dependencies status
        if (result.nodeModulesInstalled) {
            elements.depsStatus.className = 'deps-status installed';
            elements.depsStatus.innerHTML = '<span class="status-dot"></span><span>All dependencies installed</span>';
        } else {
            elements.depsStatus.className = 'deps-status missing';
            elements.depsStatus.innerHTML = `
                <span class="status-dot"></span>
                <span>Dependencies not installed</span>
                <button class="btn btn-primary btn-install-deps" style="margin-left: auto; padding: 6px 12px; font-size: 11px;">Install</button>
            `;
        }

        // Render dependencies
        renderDependencies(result.dependencies, elements.depsList);
        renderDependencies(result.devDependencies, elements.devDepsList);

        // Render scripts
        renderScripts(result.scripts, tab);

        appendConsoleTo(tab.consoleEl, `✓ Project loaded: ${result.name} v${result.version}\n`, 'success');
    } catch (error) {
        const errorMsg = error.error || error.message || String(error);
        appendConsoleTo(tab.consoleEl, `✗ ${errorMsg}\n`, 'error');

        if (activeTabId === tab.id) {
            elements.projectName.textContent = 'No Project';
            elements.projectPath.textContent = projectPath;
            elements.scriptsBar.innerHTML = '<div class="no-scripts">No package.json found</div>';
            elements.depsList.innerHTML = '<div class="dep-item"><span class="name" style="color: var(--text-muted);">None</span></div>';
            elements.devDepsList.innerHTML = '<div class="dep-item"><span class="name" style="color: var(--text-muted);">None</span></div>';

            // Ensure buttons are hidden if load fails
            elements.clearProjectBtn.classList.add('hidden');
            elements.openFinderBtn.classList.add('hidden');
            elements.selectFolderBtnText.textContent = 'Open Project';
            if (elements.killAllPortsBtn) elements.killAllPortsBtn.classList.add('hidden');
        }
    }
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
function renderScripts(scripts, tab) {
    if (activeTabId !== tab.id) return; // Only render if active tab

    elements.scriptsBar.innerHTML = '';

    // Add Install Dependencies button if needed
    if (tab.project && !tab.project.nodeModulesInstalled) {
        const installBtn = document.createElement('button');
        installBtn.className = 'script-btn btn-primary btn-install-deps';
        installBtn.innerHTML = `
            <span class="icon">📦</span>
            Install Dependencies
        `;
        installBtn.style.border = '1px solid var(--primary-color)';
        elements.scriptsBar.appendChild(installBtn);
    }

    if (Object.keys(scripts).length === 0 && (tab.project && tab.project.nodeModulesInstalled)) {
        elements.scriptsBar.innerHTML = '<div class="no-scripts">No scripts defined</div>';
        return;
    }

    for (const [name, cmd] of Object.entries(scripts)) {
        const isRunning = tab.runningScripts.has(name);

        const btn = document.createElement('button');
        btn.className = `script-btn ${isRunning ? 'running' : ''}`;
        btn.dataset.script = name;
        btn.onclick = () => toggleScript(name, tab.id);
        btn.innerHTML = `
            <span class="icon">${isRunning ? '⬛' : '▶'}</span>
            ${name}
        `;

        elements.scriptsBar.appendChild(btn);
    }
}

// Toggle Script (Run/Stop)
async function toggleScript(name, tabId = activeTabId) {
    const tab = tabs.get(tabId);
    if (!tab) return;

    if (tab.runningScripts.has(name)) {
        await stopScript(name, tabId);
    } else {
        await runScript(name, tabId);
    }
}

// Run Script
async function runScript(name, tabId = activeTabId) {
    const tab = tabs.get(tabId);
    if (!tab || !tab.project) return;

    appendConsoleTo(tab.consoleEl, `\n▶ Starting: npm run ${name}\n`, 'info');

    try {
        await invoke('run_script', {
            projectPath: tab.project.projectPath,
            scriptName: name,
            tabId: tab.id
        });
        tab.runningScripts.add(name);
        if (activeTabId === tab.id) updateScriptButtons();
    } catch (error) {
        const errorMsg = error.error || error.message || String(error);
        appendConsoleTo(tab.consoleEl, `✗ ${errorMsg}\n`, 'error');
    }
}

// Stop Script
async function stopScript(name, tabId = activeTabId) {
    const tab = tabs.get(tabId);
    if (!tab) return;

    appendConsoleTo(tab.consoleEl, `\n⬛ Stopping: ${name}\n`, 'warning');
    try {
        await invoke('stop_script', { scriptName: name, tabId: tab.id });
        tab.runningScripts.add(name); // It actually should be runningScripts.delete, but Tauri backend handles delete on exit. Still, let's pretend it's running till exited or force delete.
        // The script-exit event actually deletes it.
        // updateScriptButtons(); 
    } catch (e) {
        console.error('Failed to stop script:', e);
    }
}

// Install Dependencies
async function installDependencies() {
    const tab = getTab();
    if (!tab || !tab.project) return;

    setInstallLoading(true);
    appendConsoleTo(tab.consoleEl, `\n📦 Installing dependencies...\n`, 'info');
    try {
        const success = await invoke('install_deps', { projectPath: tab.project.projectPath, tabId: tab.id });

        if (success && tab.project) {
            tab.project.nodeModulesInstalled = true;
            if (activeTabId === tab.id) {
                elements.depsStatus.className = 'deps-status installed';
                elements.depsStatus.innerHTML = '<span class="status-dot"></span><span>All dependencies installed</span>';
            }
            appendConsoleTo(tab.consoleEl, `✓ Dependencies installed successfully\n`, 'success');

            // Reload project to update state (scripts bar, etc)
            await loadProject(tab.project.projectPath);
        }
    } catch (e) {
        appendConsoleTo(tab.consoleEl, `✗ Failed to install dependencies: ${e}\n`, 'error');
        // Only stop loading if failed, otherwise loadProject will refresh the UI
        setInstallLoading(false);
    }
}

function setInstallLoading(isLoading) {
    const btns = document.querySelectorAll('.btn-install-deps');
    btns.forEach(btn => {
        if (isLoading) {
            btn.classList.add('btn-loading');
            btn.dataset.originalText = btn.innerHTML;
            btn.innerHTML = 'Installing...';
        } else {
            btn.classList.remove('btn-loading');
            if (btn.dataset.originalText) {
                btn.innerHTML = btn.dataset.originalText;
            }
        }
    });

    if (elements.depsStatus) {
        const spans = elements.depsStatus.querySelectorAll('span');
        if (spans.length >= 2) {
            spans[1].style.display = isLoading ? 'none' : '';
        }
    }
}

// Update Script Buttons
function updateScriptButtons() {
    const tab = getTab();
    if (!tab) return;

    document.querySelectorAll('.script-btn').forEach(btn => {
        const script = btn.dataset.script;
        const isRunning = tab.runningScripts.has(script);
        btn.classList.toggle('running', isRunning);
        btn.querySelector('.icon').textContent = isRunning ? '⬛' : '▶';
    });

    // Hide URL bar if no dev/preview/start scripts are running
    const serverScripts = ['dev', 'preview', 'start', 'serve'];
    const anyServerRunning = serverScripts.some(s => tab.runningScripts.has(s));
    if (!anyServerRunning && tab.detectedUrl) {
        elements.urlBar.style.display = 'none';
        tab.detectedUrl = null;
    }
}

// Check for localhost URL in output
function checkForUrl(text, tab) {
    const patterns = [
        /https?:\/\/localhost:\d+/gi,
        /https?:\/\/127\.0\.0\.1:\d+/gi,
        /https?:\/\/\[?::1\]?:\d+/gi
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match && !tab.detectedUrl) {
            tab.detectedUrl = match[0];

            if (activeTabId === tab.id) {
                elements.urlText.textContent = tab.detectedUrl;
                elements.urlBar.style.display = 'flex';
            }
            appendConsoleTo(tab.consoleEl, `\n🚀 Server ready at: ${tab.detectedUrl}\n`, 'success');
            return;
        }
    }
}

// Append to Console
function appendConsoleTo(consoleEl, text, type = '') {
    if (!consoleEl) return;
    const welcome = consoleEl.querySelector('.console-welcome');
    if (welcome) welcome.remove();

    const span = document.createElement('span');
    span.className = type;

    // Auto-detect error/warning if no type provided
    if (!type) {
        const lower = text.toLowerCase();
        if (lower.startsWith('error') || lower.includes('error:')) {
            span.className = 'error';
        } else if (lower.startsWith('warn') || lower.includes('warning:')) {
            span.className = 'warning';
        }
    }

    span.textContent = text;
    consoleEl.appendChild(span);
    consoleEl.scrollTop = consoleEl.scrollHeight;
}

/* --- TAB MANAGEMENT --- */

function setupTabs() {
    elements.addTabBtn.addEventListener('click', createNewTab);
}

async function createNewTab() {
    const id = `tab-${nextTabId++}`;

    // Create Tab DOM
    const tabEl = document.createElement('div');
    tabEl.className = 'tab';
    tabEl.innerHTML = `
        <span class="tab-title">New Project</span>
        <div class="tab-close">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
        </div>
    `;
    elements.tabsContainer.appendChild(tabEl);

    // Create Console DOM
    const consoleEl = document.createElement('div');
    consoleEl.className = 'console hidden';
    consoleEl.id = `console-${id}`;
    consoleEl.innerHTML = DROP_ZONE_HTML;
    elements.consoleContainer.appendChild(consoleEl);

    // Setup Tab State
    const targetTab = {
        id,
        el: tabEl,
        consoleEl,
        project: null,
        detectedUrl: null,
        runningScripts: new Set()
    };
    tabs.set(id, targetTab);

    // Event Listeners
    tabEl.addEventListener('mousedown', (e) => {
        if (e.button === 0) { // Left click
            switchTab(id);
        }
    });

    tabEl.querySelector('.tab-close').addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(id);
    });

    switchTab(id);

    // For a brand new tab, we just leave it at the empty DROP ZONE unless we default load
    // Actually, only load default project for the first tab
    if (isInitialStartup && tabs.size === 1) {
        const defaultPath = await invoke('get_default_path');
        await loadProject(defaultPath);
    }
}

function switchTab(id) {
    if (activeTabId === id) return;

    // Deactivate previous
    if (activeTabId) {
        const prev = tabs.get(activeTabId);
        if (prev) {
            prev.el.classList.remove('active');
            prev.consoleEl.classList.add('hidden');
        }
    }

    activeTabId = id;
    if (window.resetClearButton) window.resetClearButton();
    const current = tabs.get(id);
    if (!current) return;

    // Activate current
    current.el.classList.add('active');
    current.consoleEl.classList.remove('hidden');

    // Restore Header UI
    if (current.project) {
        elements.projectName.textContent = current.project.name;
        elements.projectPath.textContent = current.project.projectPath;
        elements.clearProjectBtn.classList.remove('hidden');
        elements.openFinderBtn.classList.remove('hidden');
        elements.selectFolderBtnText.textContent = 'Change Project';
        if (elements.killAllPortsBtn) elements.killAllPortsBtn.classList.remove('hidden');

        // Restore Sidebar
        if (current.project.nodeModulesInstalled) {
            elements.depsStatus.className = 'deps-status installed';
            elements.depsStatus.innerHTML = '<span class="status-dot"></span><span>All dependencies installed</span>';
        } else {
            elements.depsStatus.className = 'deps-status missing';
            elements.depsStatus.innerHTML = `
                <span class="status-dot"></span>
                <span>Dependencies not installed</span>
                <button class="btn btn-primary btn-install-deps" style="margin-left: auto; padding: 6px 12px; font-size: 11px;">Install</button>
            `;
        }
        renderDependencies(current.project.dependencies, elements.depsList);
        renderDependencies(current.project.devDependencies, elements.devDepsList);
        renderScripts(current.project.scripts, current);

    } else {
        elements.projectName.textContent = 'Select a Project';
        elements.projectPath.textContent = 'No project loaded';
        elements.clearProjectBtn.classList.add('hidden');
        elements.openFinderBtn.classList.add('hidden');
        if (elements.killAllPortsBtn) elements.killAllPortsBtn.classList.add('hidden');
        elements.selectFolderBtnText.textContent = 'Open Project';

        elements.scriptsBar.innerHTML = '<div class="no-scripts">Load a project to see available scripts</div>';
        elements.depsList.innerHTML = '';
        elements.devDepsList.innerHTML = '';
        elements.depsStatus.className = 'deps-status';
        elements.depsStatus.innerHTML = '<span class="status-dot"></span><span>Not loaded</span>';
    }

    if (current.detectedUrl) {
        elements.urlText.textContent = current.detectedUrl;
        elements.urlBar.style.display = 'flex';
    } else {
        elements.urlBar.style.display = 'none';
    }

    updateScriptButtons();
}

async function closeTab(id) {
    const tabToClose = tabs.get(id);
    if (!tabToClose) return;

    if (tabToClose.project) {
        const yes = await showCustomConfirm(`Closing this tab will close the project "${tabToClose.project.name}". Are you sure?`, 'Close Project');
        if (!yes) return;
        updateHistoryOnClose(tabToClose.project.projectPath);
    }

    // Stop running scripts
    for (const script of tabToClose.runningScripts) {
        await stopScript(script, id);
    }

    // Remove DOM
    tabToClose.el.remove();
    tabToClose.consoleEl.remove();
    tabs.delete(id);

    if (tabs.size === 0) {
        activeTabId = null;
        await createNewTab(); // ensure AT LEAST ONE tab
    } else if (activeTabId === id) {
        // Switch to the last tab visually
        const lastTabId = Array.from(tabs.keys()).pop();
        switchTab(lastTabId);
    }
}

// Make functions global for inline onclick handlers
window.toggleScript = toggleScript;
window.stopScript = stopScript;
window.installDependencies = installDependencies;

// Start
init();
