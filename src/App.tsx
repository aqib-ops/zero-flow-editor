import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { EditorProvider } from "./lib/editor/store";
import { Editor } from "./components/editor/Editor";
import { HomeScreen } from "./components/editor/HomeScreen";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Toaster } from "./components/ui/sonner";
import type { SetupStatus } from "./types/window";

const SETUP_LABELS = {
  ffmpeg: "Video engine",
  whisper: "Captions engine",
} as const;

/**
 * Toasts for the background self-setup (FFmpeg / captioning downloads).
 *
 * Silent when everything already shipped with the install — only a component
 * that actually enters a busy phase gets a toast, closed by a success or an
 * error on the same id.
 */
function useSetupStatusToasts() {
  useEffect(() => {
    const api = window.zf?.setup;
    if (!api) return;

    const busy = new Set<SetupStatus["component"]>();
    const apply = (s: SetupStatus) => {
      const id = `setup-${s.component}`;
      const label = SETUP_LABELS[s.component];
      if (s.phase === "downloading" || s.phase === "extracting" || s.phase === "installing") {
        busy.add(s.component);
        toast.loading(s.detail ?? `Setting up ${label}…`, { id });
      } else if (s.phase === "ready") {
        if (busy.delete(s.component)) toast.success(`${label} ready`, { id });
      } else if (s.phase === "error") {
        busy.delete(s.component);
        toast.error(s.detail ?? `${label} setup failed`, { id, duration: 10_000 });
      }
    };

    // Subscribe before reading the snapshot so nothing in flight is missed;
    // duplicate events land on the same toast id and coalesce.
    const off = api.onStatus(apply);
    api.status().then((snap) => {
      for (const component of ["ffmpeg", "whisper"] as const) {
        const phase = snap[component];
        if (phase === "downloading" || phase === "extracting" || phase === "installing") {
          apply({ component, phase, detail: snap.message ?? undefined });
        } else if (phase === "error") {
          apply({ component, phase, detail: snap.message ?? undefined });
        }
      }
    }).catch(() => {
      /* no preload (plain browser dev) — nothing to report */
    });
    return off;
  }, []);
}

/** Random project id matching the store's `[a-z0-9-]{1,64}` rule. */
const newProjectId = (): string =>
  `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function App() {
  // The open project's id survives home↔editor navigation: the timeline state
  // lives in EditorProvider above both screens, and keeping the id means the
  // next autosave overwrites the same file instead of forking a duplicate.
  const [projectId, setProjectId] = useState<string | null>(null);
  const [screen, setScreen] = useState<"home" | "editor">("home");
  const [projectName, setProjectName] = useState("Untitled project");

  useSetupStatusToasts();

  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message =
        reason instanceof Error ? reason.message : String(reason ?? "Unexpected error");
      console.error("[app] unhandled promise rejection", reason);
      toast.error(message);
    };
    const onError = (event: ErrorEvent) => {
      console.error("[app] uncaught error", event.error ?? event.message);
    };
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError);
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onError);
    };
  }, []);

  const enterEditor = useCallback((info: { id: string; name: string }) => {
    setProjectId(info.id);
    setProjectName(info.name);
    setScreen("editor");
  }, []);

  // "New project": fresh id so the autosave starts a new file and every
  // existing project stays in recents untouched.
  const startNewProject = useCallback(
    (name: string) => enterEditor({ id: newProjectId(), name }),
    [enterEditor],
  );

  const goHome = useCallback(() => setScreen("home"), []);

  return (
    <ErrorBoundary>
      <EditorProvider>
        {screen === "home" ? (
          <HomeScreen
            onNewProject={startNewProject}
            onOpenProject={enterEditor}
          />
        ) : (
          <Editor
            projectId={projectId ?? ""}
            projectName={projectName}
            onHome={goHome}
            onProjectChange={enterEditor}
          />
        )}
        <Toaster />
      </EditorProvider>
    </ErrorBoundary>
  );
}
