import { getSettings } from "../common/storage.js";
import { exportAsJson } from "./exporter.js";

export interface AutoExportSettings {
  enabled: boolean;
  /** Relative filename within the user's Downloads folder. */
  filename: string;
}

export const DEFAULT_AUTO_EXPORT: AutoExportSettings = {
  enabled: false,
  filename: "membral/conversations.json",
};

/**
 * If auto-export is enabled in settings, generate conversations JSON
 * and write it to the configured filename via chrome.downloads API.
 * Uses conflictAction: 'overwrite' so the MCP file watcher always
 * sees the latest data at a predictable path.
 */
export async function autoExportIfEnabled(): Promise<{ exported: boolean; path?: string }> {
  const settings = await getSettings();
  const autoExport = settings.autoExport ?? DEFAULT_AUTO_EXPORT;

  if (!autoExport.enabled) {
    return { exported: false };
  }

  const { url } = await exportAsJson();
  const filename = autoExport.filename || DEFAULT_AUTO_EXPORT.filename;

  await chrome.downloads.download({
    url,
    filename,
    conflictAction: "overwrite",
    saveAs: false,
  });

  return { exported: true, path: filename };
}
