export const attachmentAccept = ".pdf,.docx,.txt,.csv,.xlsx";
export function attachmentError(file: {
  name: string;
  size: number;
}): string | undefined {
  if (!/\.(pdf|docx|txt|csv|xlsx)$/i.test(file.name))
    return `${file.name}: use a PDF, Word document, text file, CSV, or Excel workbook.`;
  if (!file.size) return `${file.name} is empty. Choose a file with content.`;
  if (file.size > 20 * 1024 * 1024)
    return `${file.name} is too large. Use files up to 20 MB.`;
  return undefined;
}
