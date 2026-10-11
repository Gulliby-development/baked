import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  Notification,
  shell,
  type WebContents,
} from "electron";
import type { AppSettings, AttentionItem, DesktopProject } from "../shared/api.js";
import { attentionHash, attentionTitle, kindLabel } from "../shared/attention.js";
import { type HttpMethod, IPC, type ProjectAction, type WindowAction } from "../shared/bridge.js";
import { AttentionHub } from "./attention.js";
import { Backend } from "./backend.js";
import { resolveBackendCommand } from "./backend-command.js";
import { addKnownProject, cliRunner, listKnownProjects } from "./baked-cli.js";
import { readGitBranch } from "./git-branch.js";
import { manageKnownProject } from "./project-actions.js";
import { SettingsStore } from "./settings.js";
import { ProjectSupervisor, type Stream } from "./supervisor.js";
import { AppTray } from "./tray.js";
import { closeAction } from "./tray-model.js";

const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const settings = new SettingsStore(join(app.getPath("userData"), "settings.json"));
const tokenDir = join(app.getPath("userData"), "tokens");

function backendCommand() {
  return resolveBackendCommand({
    override: settings.get().bakedPath,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    repoRoot: resolve(app.getAppPath(), "..", ".."),
    platform: process.platform,
  });
}

let window: BrowserWindow | null = null;
let quitting = false;
const broadcast = (channel: string, ...args: unknown[]): void => {
  if (window && !window.isDestroyed()) window.webContents.send(channel, ...args);
};

function showWindow(hash?: string): void {
  if (!window) createWindow();
  if (window?.isMinimized()) window.restore();
  window?.show();
  window?.focus();
  if (hash) broadcast(IPC.navigate, hash);
}

const tray = new AppTray({
  show: () => showWindow(),
  showAttention: () => showWindow("#/attention"),
  quit: () => app.quit(),
});

const attention = new AttentionHub((items, added) => {
  broadcast(IPC.attentionChanged, items);
  tray.update(items);
  notify(added);
});
const attentionStreams = new Map<string, Stream>();

const supervisor = new ProjectSupervisor({
  listProjects: () => listKnownProjects(cliRunner(backendCommand())),
  readBranch: readGitBranch,
  createBackend: (project, key, onState) => {
    mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
    return new Backend({
      folder: project.path,
      command: backendCommand(),
      tokenFile: join(tokenDir, `${key}.token`),
      onState,
    });
  },
  onChange: (projects) => {
    syncAttention(projects);
    broadcast(IPC.projectsChanged, projects);
  },
});

/** Keeps one attention stream per open project. */
function syncAttention(projects: DesktopProject[]): void {
  for (const project of projects) {
    if (project.open && !attentionStreams.has(project.key))
      attentionStreams.set(
        project.key,
        supervisor.stream(project.key, "/v1/attention", (event) =>
          attention.event(project.key, project.name, event),
        ),
      );
    if (!project.open && attentionStreams.has(project.key)) {
      attentionStreams.get(project.key)?.close();
      attentionStreams.delete(project.key);
      attention.remove(project.key);
    }
  }
}

function notify(items: AttentionItem[]): void {
  if (!Notification.isSupported()) return;
  const { notifyBlocking, notifyAdvisory } = settings.get();
  for (const item of items) {
    if (item.blocking ? !notifyBlocking : !notifyAdvisory) continue;
    const notification = new Notification({
      title: `${item.projectName}: ${attentionTitle(item)}`,
      body: `${item.blocking ? "Waiting for you" : "For your review"}: ${kindLabel(item.kind)}`,
    });
    notification.on("click", () => showWindow(attentionHash(item)));
    notification.show();
  }
}

function rememberOpen(): void {
  const keys = new Set(supervisor.openKeys());
  settings.update({
    openProjects: supervisor
      .projects()
      .filter((p) => keys.has(p.key))
      .map((p) => p.path),
  });
}

/** Streams the renderer subscribed to, per window, so a reload or close ends them. */
const streams = new Map<WebContents, Map<string, Stream>>();
function streamsOf(contents: WebContents): Map<string, Stream> {
  let map = streams.get(contents);
  if (!map) {
    map = new Map();
    streams.set(contents, map);
    const end = (): void => {
      for (const stream of map?.values() ?? []) stream.close();
      streams.delete(contents);
    };
    contents.once("destroyed", end);
    contents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) end();
    });
  }
  return map;
}

function handle<A extends unknown[], R>(
  channel: string,
  fn: (event: IpcMainInvokeEvent, ...args: A) => Promise<R> | R,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    // Only the app's own page may call into the main process.
    if (event.senderFrame?.url && !isAppUrl(event.senderFrame.url))
      throw new Error("Refused: unknown sender");
    return fn(event, ...(args as A));
  });
}

function isAppUrl(url: string): boolean {
  if (devServerUrl && url.startsWith(devServerUrl)) return true;
  return url.startsWith("file://");
}

function registerIpc(): void {
  handle(IPC.projects, () => supervisor.projects());
  handle(IPC.refreshProjects, () => supervisor.refresh());
  handle(IPC.openProject, async (_e, key: string) => {
    await supervisor.open(key);
    rememberOpen();
  });
  handle(IPC.closeProject, async (_e, key: string) => {
    await supervisor.close(key);
    rememberOpen();
  });
  handle(IPC.restartProject, (_e, key: string) => supervisor.restart(key));
  handle(IPC.addFolder, async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    const folder = result.filePaths[0];
    if (result.canceled || !folder) return null;
    await addKnownProject(cliRunner(backendCommand()), folder);
    const projects = await supervisor.refresh();
    return projects.find((p) => resolve(p.path) === resolve(folder)) ?? null;
  });
  handle(IPC.manageProject, async (_e, key: string, action: ProjectAction) => {
    const project = supervisor.projects().find((p) => p.key === key);
    if (!project) throw new Error("Unknown project");
    if (action === "forget" && project.open) await supervisor.close(key);
    const running = supervisor.projects().filter((p) => p.open && p.backend.kind === "running");
    await manageKnownProject(
      project.path,
      action,
      running.map((p) => (path, body) => supervisor.request(p.key, "POST", path, body)),
      cliRunner(backendCommand()),
    );
    if (action === "forget") rememberOpen();
    return supervisor.refresh();
  });
  handle(IPC.request, (_e, key: string, method: HttpMethod, path: string, body?: unknown) =>
    supervisor.request(key, method, path, body),
  );
  handle(IPC.subscribe, (event, id: string, key: string, path: string, lastEventId?: string) => {
    const contents = event.sender;
    const map = streamsOf(contents);
    map.get(id)?.close();
    map.set(
      id,
      supervisor.stream(
        key,
        path,
        (streamEvent) => {
          if (!contents.isDestroyed()) contents.send(IPC.streamEvent, id, streamEvent);
        },
        lastEventId,
      ),
    );
  });
  handle(IPC.unsubscribe, (event, id: string) => {
    const map = streams.get(event.sender);
    map?.get(id)?.close();
    map?.delete(id);
  });
  handle(IPC.attention, () => attention.items());
  handle(IPC.settings, () => settings.get());
  handle(IPC.updateSettings, (_e, patch: Partial<AppSettings>) => settings.update(patch));
  handle(IPC.openExternal, async (_e, url: string) => {
    if (!/^https:\/\//.test(url)) throw new Error("Only https links open outside the app");
    await shell.openExternal(url);
  });
  handle(IPC.windowAction, (event, action: WindowAction) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (!target) return;
    if (action === "minimize") target.minimize();
    else if (action === "maximize") {
      if (target.isMaximized()) target.unmaximize();
      else target.maximize();
    } else if (action === "close") target.close();
  });
  handle(
    IPC.windowState,
    (event) => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false,
  );
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#191410",
    title: "BAKED",
    show: false,
    // The app draws its own title bar: macOS keeps its traffic lights inset in it, Windows and
    // Linux get the app's own window buttons (TitleBar.tsx).
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 11 } }
      : { frame: false }),
    webPreferences: {
      preload: join(app.getAppPath(), "out", "preload", "index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.once("ready-to-show", () => window?.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  if (devServerUrl) void window.loadURL(devServerUrl);
  else void window.loadFile(join(app.getAppPath(), "out", "renderer", "index.html"));
  window.on("close", (event) => {
    if (quitting || !settings.get().keepRunningInTray) return;
    // Whether a run still works is read fresh; the list may be minutes old.
    event.preventDefault();
    const current = window;
    void supervisor
      .refresh()
      .catch(() => supervisor.projects())
      .then((projects) => {
        if (!current || current.isDestroyed()) return;
        const action = closeAction({
          quitting,
          keepRunningInTray: settings.get().keepRunningInTray,
          projects,
        });
        if (action === "hide") {
          current.hide();
          tray.show();
        } else {
          current.destroy();
        }
      });
  });
  window.on("show", () => tray.hide());
  window.on("maximize", () => broadcast(IPC.windowMaximized, true));
  window.on("unmaximize", () => broadcast(IPC.windowMaximized, false));
  window.on("closed", () => {
    window = null;
  });
}

async function boot(): Promise<void> {
  registerIpc();
  createWindow();
  try {
    await supervisor.refresh();
  } catch (error) {
    dialog.showErrorBox(
      "BAKED could not list projects",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  if (!settings.get().openLastProjects) return;
  const keys = new Map(supervisor.projects().map((p) => [p.path, p.key]));
  for (const path of settings.get().openProjects) {
    const key = keys.get(path);
    if (key) void supervisor.open(key).catch(() => undefined);
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(boot, (error: unknown) => {
    dialog.showErrorBox("BAKED failed to start", String(error));
    app.quit();
  });
  app.on("activate", () => showWindow());
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", (event) => {
    if (quitting) return;
    // Backends get to pause their active runs before the app exits.
    event.preventDefault();
    quitting = true;
    for (const stream of attentionStreams.values()) stream.close();
    void supervisor.stopAll().finally(() => app.quit());
  });
}
