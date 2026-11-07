#!/usr/bin/env python3
"""Generate the "Reading capture" Shortcut as a signed .shortcut file and open it for import.

    python3 tools/reading-capture-shortcut.py            # writes + signs + opens
    python3 tools/reading-capture-shortcut.py out.dir    # custom output dir

Share-sheet shortcut: appends "YYYY-MM-DD HH.mm <url>" to capture-<Device Name>.txt in the
Shortcuts iCloud folder and shows a notification. Every action input is a WFTextTokenString
template on purpose — bare attachments and implicit previous-output chaining are silently
ignored by Shortcuts when importing generated files (macOS/iOS 26).
"""
import os
import plistlib
import subprocess
import sys
import uuid

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/Downloads")
U = lambda: str(uuid.uuid4()).upper()
u_dev, u_date, u_urls = U(), U(), U()


def out(u, name):
    return {"OutputUUID": u, "Type": "ActionOutput", "OutputName": name}


def tok(parts):
    """Text template: strings stay literal, dicts become variable attachments."""
    s, att = "", {}
    for p in parts:
        if isinstance(p, str):
            s += p
        else:
            att[f"{{{len(s)}, 1}}"] = p
            s += "￼"
    return {"Value": {"string": s, "attachmentsByRange": att}, "WFSerializationType": "WFTextTokenString"}


actions = [
    {"WFWorkflowActionIdentifier": "is.workflow.actions.detect.link",
     "WFWorkflowActionParameters": {"UUID": u_urls, "WFInput": tok([{"Type": "ExtensionInput"}])}},
    {"WFWorkflowActionIdentifier": "is.workflow.actions.format.date",
     "WFWorkflowActionParameters": {"UUID": u_date, "WFDateFormatStyle": "Custom",
                                    "WFDateFormat": "yyyy-MM-dd HH.mm", "WFDate": tok([{"Type": "CurrentDate"}])}},
    {"WFWorkflowActionIdentifier": "is.workflow.actions.getdevicedetails",
     "WFWorkflowActionParameters": {"UUID": u_dev, "WFDeviceDetail": "Device Name"}},
    {"WFWorkflowActionIdentifier": "is.workflow.actions.file.append",
     "WFWorkflowActionParameters": {"WFInput": tok([out(u_date, "Formatted Date"), " ", out(u_urls, "URLs")]),
                                    "WFAppendOnNewLine": True, "WFAskWhereToSave": False,
                                    "WFFileStorageService": "iCloud Drive",
                                    "WFFilePath": tok(["capture-", out(u_dev, "Device Name"), ".txt"])}},
    {"WFWorkflowActionIdentifier": "is.workflow.actions.notification",
     "WFWorkflowActionParameters": {"WFNotificationActionBody": tok(["Captured ", out(u_urls, "URLs")]),
                                    "WFNotificationActionSound": False}},
]
workflow = {
    "WFWorkflowMinimumClientVersion": 900, "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowClientVersion": "2607.0.3",
    "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4282601983, "WFWorkflowIconGlyphNumber": 59511},
    "WFWorkflowTypes": ["ActionExtension"],
    "WFWorkflowInputContentItemClasses": ["WFURLContentItem", "WFSafariWebPageContentItem", "WFStringContentItem",
                                          "WFRichTextContentItem", "WFPDFContentItem"],
    "WFWorkflowNoInputBehavior": {"Name": "WFWorkflowNoInputBehaviorGetClipboard", "Parameters": {}},
    "WFWorkflowHasShortcutInputVariables": True, "WFWorkflowHasOutputFallback": False,
    "WFWorkflowImportQuestions": [], "WFWorkflowOutputContentItemClasses": [],
    "WFWorkflowActions": actions,
}

os.makedirs(OUT, exist_ok=True)
unsigned = os.path.join(OUT, "Reading capture.unsigned.shortcut")
signed = os.path.join(OUT, "Reading capture.shortcut")
with open(unsigned, "wb") as f:
    plistlib.dump(workflow, f, fmt=plistlib.FMT_BINARY)
subprocess.run(["shortcuts", "sign", "--mode", "anyone", "--input", unsigned, "--output", signed], check=True)
os.remove(unsigned)
subprocess.run(["open", signed], check=True)
print(f"opened {signed} — click Add in Shortcuts; it syncs to iPhone/iPad via iCloud")
