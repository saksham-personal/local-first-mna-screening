import { useState, type DragEvent, type ReactNode } from "react";

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
      data-file-drop-zone="true"
      data-dragging={dragging || undefined}
      onDragEnter={(event) => {
        if (isFiles(event)) {
          event.preventDefault();
          event.stopPropagation();
          setDragging(true);
        }
      }}
      onDragOver={(event) => {
        if (isFiles(event)) {
          event.preventDefault();
          event.stopPropagation();
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
          <strong>Drop files here</strong>
        </div>
      )}
    </div>
  );
}
