import { useEffect } from "react";
import { toast } from "sonner";
import { EditorProvider } from "./lib/editor/store";
import { Editor } from "./components/editor/Editor";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Toaster } from "./components/ui/sonner";

export function App() {
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

  return (
    <ErrorBoundary>
      <EditorProvider>
        <Editor />
        <Toaster />
      </EditorProvider>
    </ErrorBoundary>
  );
}
