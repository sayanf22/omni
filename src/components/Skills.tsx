import React from "react";
import { MousePointer, Keyboard, Monitor, Folder, Clipboard, Chrome, Slack, PenTool } from "lucide-react";

export const Skills: React.FC = () => {
  const skills = [
    { icon: MousePointer, name: "Mouse Click & Drag", desc: "Win32 direct cursor positioning, clicking, and scrolling simulation.", tier: "active" },
    { icon: Keyboard, name: "Keyboard Simulation", desc: "Single keys, combined modifiers, and clipboard-fallback text typing.", tier: "active" },
    { icon: Monitor, name: "OCR & Screen Analysis", desc: "Built-in WinRT screen capture, text parsing, and UI element coordinate mapping.", tier: "active" },
    { icon: Folder, name: "FileSystem Operations", desc: "Reading, writing, creating directories, and secure folder cleanups.", tier: "active" },
    { icon: Clipboard, name: "Clipboard Operations", desc: "Reading text buffers and writing output formats directly.", tier: "active" },
    { icon: Chrome, name: "Browser Automation", desc: "Automated Chrome session controls, page loading, and field scraping.", tier: "active" },
    { icon: Slack, name: "Slack & Teams Messaging", desc: "Send direct notifications, post to channels, and check active feed alerts.", tier: "v2" },
    { icon: PenTool, name: "Creative Suite Actions", desc: "Batch operations in Photoshop, DaVinci Resolve, and Illustrator.", tier: "v2" }
  ];

  return (
    <div className="space-y-6">
      {/* Title */}
      <div>
        <h1 className="text-2xl font-bold text-text">Skills Catalog</h1>
        <p className="text-text-secondary text-sm">Review loaded system drivers and third-party API integration status.</p>
      </div>

      {/* Skills Grid */}
      <div className="grid grid-cols-4 gap-4">
        {skills.map((skill, index) => {
          const Icon = skill.icon;
          return (
            <div key={index} className="bg-surface border border-border rounded-xl p-5 space-y-3 flex flex-col justify-between shadow-sm">
              <div className="space-y-2">
                <div className="w-10 h-10 rounded-lg bg-surface2 border border-border flex items-center justify-center text-accent">
                  <Icon className="w-5 h-5" />
                </div>
                <h4 className="font-semibold text-text text-sm">{skill.name}</h4>
                <p className="text-xs text-text-secondary leading-relaxed">{skill.desc}</p>
              </div>

              <div className="pt-2">
                <span className={`inline-block px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${
                  skill.tier === "active"
                    ? "bg-success/15 text-success border border-success/20"
                    : "bg-surface3 text-text-muted border border-border"
                }`}>
                  {skill.tier === "active" ? "Active" : "V2 Marketplace"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
