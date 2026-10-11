import { join } from "node:path";
import { app, type BrowserWindow, Menu, nativeImage, Tray } from "electron";
import type { AttentionItem } from "../shared/api.js";
import { badgeBitmap, badgeLabel, trayModel } from "./tray-model.js";

export interface TrayActions {
  show(): void;
  showAttention(): void;
  quit(): void;
  /** The main window, whose taskbar button carries the Windows overlay badge. */
  window(): BrowserWindow | null;
}

const BADGE_SIZE = 32;

/** The tray icon of a hidden window, and the dock or taskbar badge of blocking items. */
export class AppTray {
  private tray: Tray | null = null;
  private items: AttentionItem[] = [];
  /** The overlay label last set on the window, so an unchanged count does not redraw it. */
  private overlay: { window: BrowserWindow; label: string | null } | null = null;

  constructor(private readonly actions: TrayActions) {}

  /** Shows the tray icon; the window was hidden into it. */
  show(): void {
    if (this.tray) return;
    // macOS draws the one-colour template in the menu bar colour; elsewhere the orange oven shows.
    const mac = process.platform === "darwin";
    const file = mac ? "trayTemplate.png" : "tray.png";
    const icon = nativeImage.createFromPath(join(app.getAppPath(), "build", file));
    if (mac) icon.setTemplateImage(true);
    this.tray = new Tray(icon);
    this.tray.on("click", () => this.actions.show());
    this.render();
  }

  hide(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  update(items: AttentionItem[]): void {
    this.items = items;
    this.render();
  }

  /** Sets the badge again, for a window created after the last update. */
  refreshBadge(): void {
    this.renderBadge(trayModel(this.items).badge);
  }

  private renderBadge(count: number): void {
    // Supported on macOS and on Linux desktops with Unity launcher badges.
    if (process.platform !== "win32") {
      app.setBadgeCount(count);
      return;
    }
    // Windows has no badge count: the taskbar button gets a drawn overlay icon instead.
    const window = this.actions.window();
    if (!window || window.isDestroyed()) return;
    const label = badgeLabel(count);
    if (this.overlay?.window === window && this.overlay.label === label) return;
    this.overlay = { window, label };
    if (!label) {
      window.setOverlayIcon(null, "");
      return;
    }
    const icon = nativeImage.createFromBitmap(badgeBitmap(label, BADGE_SIZE), {
      width: BADGE_SIZE,
      height: BADGE_SIZE,
    });
    window.setOverlayIcon(icon, `${count} need you`);
  }

  private render(): void {
    const model = trayModel(this.items);
    this.renderBadge(model.badge);
    if (!this.tray) return;
    this.tray.setToolTip(model.tooltip);
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Show BAKED", click: () => this.actions.show() },
        ...(model.needYou
          ? [{ label: model.needYou, click: () => this.actions.showAttention() }]
          : []),
        { type: "separator" },
        { label: "Quit", click: () => this.actions.quit() },
      ]),
    );
  }
}
