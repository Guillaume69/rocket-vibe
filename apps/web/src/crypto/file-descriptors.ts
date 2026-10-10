import type { FileDescriptor } from "../protocol";
export function nativeFileAttachments(
  files: readonly FileDescriptor[],
  _room: string,
): Record<string, unknown>[] {
  return files.map((file) => ({
    type: "file",
    fileId: file.id,
    native_file: file,
    title: file.filename,
    title_link: "/api/v1/files/" + encodeURIComponent(file.id),
    size: Number(file.bytes),
  }));
}
