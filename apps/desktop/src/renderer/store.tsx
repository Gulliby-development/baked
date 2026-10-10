import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { AppSettings, AttentionItem, DesktopProject } from "../shared/api.js";
import { bridge } from "./client/bridge.js";

interface DesktopState {
  projects: DesktopProject[];
  attention: AttentionItem[];
  settings: AppSettings | null;
  error: string | null;
  refresh(): Promise<void>;
  open(key: string): Promise<void>;
  close(key: string): Promise<void>;
  restart(key: string): Promise<void>;
  addFolder(): Promise<DesktopProject | null>;
  updateSettings(patch: Partial<AppSettings>): Promise<void>;
}

const Context = createContext<DesktopState | null>(null);

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function DesktopProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<DesktopProject[]>([]);
  const [attention, setAttention] = useState<AttentionItem[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void bridge.projects().then(setProjects, (e: unknown) => setError(message(e)));
    void bridge.attention().then(setAttention);
    void bridge.settings().then(setSettings);
    const offProjects = bridge.onProjects(setProjects);
    const offAttention = bridge.onAttention(setAttention);
    const offNavigate = bridge.onNavigate((hash) => {
      window.location.hash = hash;
    });
    return () => {
      offProjects();
      offAttention();
      offNavigate();
    };
  }, []);

  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      root.dataset.theme =
        settings.theme === "system" ? (dark.matches ? "dark" : "light") : settings.theme;
    };
    apply();
    root.dataset.density = settings.density;
    dark.addEventListener("change", apply);
    return () => dark.removeEventListener("change", apply);
  }, [settings]);

  const guard = useCallback(async <T,>(work: () => Promise<T>): Promise<T | null> => {
    try {
      setError(null);
      return await work();
    } catch (e) {
      setError(message(e));
      return null;
    }
  }, []);

  const value = useMemo<DesktopState>(
    () => ({
      projects,
      attention,
      settings,
      error,
      refresh: async () => {
        const list = await guard(() => bridge.refreshProjects());
        if (list) setProjects(list);
      },
      open: async (key) => {
        await guard(() => bridge.openProject(key));
      },
      close: async (key) => {
        await guard(() => bridge.closeProject(key));
      },
      restart: async (key) => {
        await guard(() => bridge.restartProject(key));
      },
      addFolder: async () => (await guard(() => bridge.addFolder())) ?? null,
      updateSettings: async (patch) => {
        const next = await guard(() => bridge.updateSettings(patch));
        if (next) setSettings(next);
      },
    }),
    [projects, attention, settings, error, guard],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useDesktop(): DesktopState {
  const state = useContext(Context);
  if (!state) throw new Error("useDesktop needs a DesktopProvider");
  return state;
}

export function useProject(key: string): DesktopProject | undefined {
  return useDesktop().projects.find((p) => p.key === key);
}
