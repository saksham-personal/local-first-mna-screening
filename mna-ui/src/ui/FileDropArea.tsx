import { useState, type DragEvent, type ReactNode } from "react";
import { UploadCloud } from "lucide-react";

/** Claims only file drags; ordinary text selections and links still work. */
export default function FileDropArea({
  children,
  className,
  onFiles,
}: {
  children: ReactNode;
  className: string;
  onFiles: (files: File[]) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const isFiles = (event: DragEvent) =>
    event.dataTransfer.types.includes("Files");
  return (
    <div
      className={`${className} ui-file-drop-area`}
      data-dragging={dragging || undefined}
      onDragEnter={(event) => {
        if (isFiles(event)) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragOver={(event) => {
        if (isFiles(event)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDragging(false);
      }}
      onDrop={(event) => {
        if (!isFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setDragging(false);
        onFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {children}
      {dragging && (
        <div className="ui-file-drop-overlay" role="status">
          <div>
            <UploadCloud size={30} />
            <strong>Drop files to attach</strong>
            <span>PDF, Word, text, CSV, or Excel · up to 20 MB each</span>
            <small>Review the attachments in chat, then send.</small>
          </div>
        </div>
      )}
    </div>
  );
}
