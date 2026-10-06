import { EditorProvider } from "./lib/editor/store";
import { Editor } from "./components/editor/Editor";
import { Toaster } from "./components/ui/sonner";

export function App() {
  return (
    <EditorProvider>
      <Editor />
      <Toaster />
    </EditorProvider>
  );
}
