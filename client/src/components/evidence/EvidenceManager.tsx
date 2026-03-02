import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Upload, Download, Trash2 } from "lucide-react";

type AttachmentRow = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
};

type AttachmentEntityType = "attendance_record" | "training_event" | "employee";

type Props = {
  entityType: AttachmentEntityType;
  entityId: string | null | undefined;
  canUpload: boolean;
  canDelete: boolean;
};

async function fetchAttachments(entityType: AttachmentEntityType, entityId: string) {
  const query = new URLSearchParams({ entityType, entityId }).toString();
  const res = await fetch(`/api/attachments?${query}`, { credentials: "include" });
  if (!res.ok) {
    throw new Error("Failed to load attachments.");
  }
  return res.json() as Promise<{ attachments: AttachmentRow[] }>;
}

function formatFileSize(sizeBytes: number) {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const kb = sizeBytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export default function EvidenceManager({
  entityType,
  entityId,
  canUpload,
  canDelete,
}: Props) {
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["/api/attachments", entityType, entityId || ""],
    queryFn: () => fetchAttachments(entityType, entityId || ""),
    enabled: Boolean(entityId),
  });

  const attachments = data?.attachments ?? [];

  const handleUpload = async (file: File) => {
    if (!entityId) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("entityType", entityType);
      form.append("entityId", entityId);
      const res = await fetch("/api/attachments/upload", {
        method: "POST",
        body: form,
        credentials: "include",
      });
      if (!res.ok) {
        throw new Error("Upload failed.");
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/attachments", entityType, entityId] });
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (attachmentId: string) => {
    await apiRequest("DELETE", `/api/attachments/${attachmentId}`);
    if (!entityId) return;
    await queryClient.invalidateQueries({ queryKey: ["/api/attachments", entityType, entityId] });
  };

  if (!entityId) {
    return <p className="text-sm text-muted-foreground">Save this record first to manage evidence.</p>;
  }

  return (
    <div className="space-y-3">
      {canUpload ? (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? (
              <>
                <Spinner className="mr-2 h-4 w-4" />
                Uploading...
              </>
            ) : (
              <>
                <Upload className="mr-2 h-4 w-4" />
                Upload Evidence
              </>
            )}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept=".pdf,.jpg,.jpeg,.png"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                void handleUpload(file);
              }
              event.currentTarget.value = "";
            }}
          />
        </div>
      ) : null}

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" />
          Loading attachments...
        </div>
      ) : attachments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No evidence files uploaded yet.</p>
      ) : (
        <div className="space-y-2">
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              className="flex items-center justify-between rounded-md border px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{attachment.fileName}</p>
                <p className="text-xs text-muted-foreground">
                  {formatFileSize(attachment.sizeBytes)} ·{" "}
                  {new Date(attachment.uploadedAt).toLocaleDateString("en-US")}
                </p>
              </div>
              <div className="ml-3 flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(`/api/attachments/${attachment.id}/download`, "_blank")}
                >
                  <Download className="mr-2 h-4 w-4" />
                  Download
                </Button>
                {canDelete ? (
                  <Button variant="outline" size="sm" onClick={() => handleDelete(attachment.id)}>
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
