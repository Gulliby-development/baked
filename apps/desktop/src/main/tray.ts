import { join } from "node:path";
import { app, Menu, nativeImage, Tray } from "electron";
import type { AttentionItem } from "../shared/api.js";
import { trayModel } from "./tray-model.js";

export interface TrayActions {
  show(): void;
  showAttention(): void;
  quit(): void;
}

/** The tray icon of a hidden window, and the dock or taskbar badge of blocking items. */
export class AppTray {
  private tray: Tray | null = null;
  private items: AttentionItem[] = [];

  constructor(private readonly actions: TrayActions) {}

  /** Shows the tray icon; the window was hidden into it. */
  show(): void {
    if (this.tray) return;
    const icon = nativeImage.createFromPath(join(app.getAppPath(), "build", "tray.png"));
    if (process.platform === "darwin") icon.setTemplateImage(true);
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

  private render(): void {
    const model = trayModel(this.items);
    // Supported on macOS and on Linux desktops with Unity launcher badges.
    app.setBadgeCount(model.badge);
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
