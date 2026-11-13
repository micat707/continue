import { useContext, useEffect, useState } from "react";
import type {
  DeepAgentPermissionAction,
  DeepAgentPermissionConfig,
  DeepAgentPermissionMergedRule,
  DeepAgentPermissionsState,
} from "core/protocol/ideWebview";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { Card } from "../../../components/ui";
import { ConfigHeader } from "../components/ConfigHeader";

const TOOLS: Array<{ tool: string; desc: string }> = [
  { tool: "read_file", desc: "读取文件" },
  { tool: "write_file", desc: "新建/修改普通文件" },
  { tool: "edit_file", desc: "编辑文件" },
  { tool: "delete_file", desc: "删除文件/文件夹" },
  { tool: "delete", desc: "删除文件/文件夹" },
  { tool: "ls", desc: "列目录" },
  { tool: "glob", desc: "搜索文件" },
  { tool: "grep", desc: "搜索内容" },
  { tool: "execute", desc: "执行命令（任意 shell，不受路径约束）" },
];

/** File tools are subject to the hard red line: never "allow" outside trust. */
const FILE_TOOLS = [
  "read_file",
  "write_file",
  "edit_file",
  "delete_file",
  "delete",
];

/**
 * Tools that can NEVER be "allow" in ANY scope. `execute` runs an arbitrary
 * shell command — it can touch any file, the network, any process — so the
 * trusted/untrusted path distinction is meaningless for it. Its options are
 * 需要审批 (default) or 禁止 only.
 */
const NO_ALLOW_TOOLS = ["execute"];

const ACTION_LABELS: Record<DeepAgentPermissionAction, string> = {
  allow: "✅ 无需审批",
  ask: "⚠️ 需要审批",
  deny: "🚫 禁止",
};

const SOURCE_LABELS: Record<string, string> = {
  global: "继承全局",
  workspace: "继承项目",
  session: "继承会话",
};

const SOURCE_COLORS: Record<string, string> = {
  global: "text-sky-400",
  workspace: "text-emerald-400",
  session: "text-amber-400",
};

type LayerKey = "global" | "workspace" | "session";

const LAYER_TABS: Array<{ id: LayerKey; label: string }> = [
  { id: "global", label: "🌐 全局默认" },
  { id: "workspace", label: "📁 当前项目" },
  { id: "session", label: "💬 本次会话" },
];

function clone<T>(o: T): T {
  return JSON.parse(JSON.stringify(o));
}

function RuleTable({
  scope,
  layer,
  draft,
  merged,
  onChange,
}: {
  scope: "trustRules" | "untrustRules";
  layer: LayerKey;
  draft: DeepAgentPermissionConfig;
  merged: DeepAgentPermissionMergedRule[];
  onChange: (
    scope: "trustRules" | "untrustRules",
    tool: string,
    action: DeepAgentPermissionAction,
  ) => void;
}) {
  const byTool = new Map(merged.map((r) => [r.tool, r]));
  const rules = draft[scope] ?? [];

  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-gray-700/60 text-left text-xs text-gray-400">
          <th className="px-3 py-2 font-medium">工具</th>
          <th className="px-3 py-2 font-medium">说明</th>
          <th className="px-3 py-2 font-medium">策略</th>
          <th className="px-3 py-2 font-medium">来源</th>
        </tr>
      </thead>
      <tbody>
        {TOOLS.map((t) => {
          const mergedRule = byTool.get(t.tool);
          const effective = mergedRule?.action ?? "ask";
          const source = mergedRule?.source ?? "global";
          const own = rules.find((r) => r.tool === t.tool);
          const isOwn = source === layer || !!own;
          const value = own ? own.action : effective;
          const isFile = FILE_TOOLS.includes(t.tool);
          const noAllow = NO_ALLOW_TOOLS.includes(t.tool);
          const redLine = noAllow || (scope === "untrustRules" && isFile);

          return (
            <tr
              key={t.tool}
              className="border-b border-gray-800/60 last:border-0"
            >
              <td className="px-3 py-2 font-mono text-xs text-violet-300">
                {t.tool}
              </td>
              <td className="px-3 py-2 text-gray-400">{t.desc}</td>
              <td className="px-3 py-2">
                <select
                  className="rounded border border-gray-600 bg-gray-800 px-2 py-1 text-xs text-gray-100 disabled:opacity-40"
                  value={value}
                  disabled={!isOwn}
                  onChange={(e) =>
                    onChange(
                      scope,
                      t.tool,
                      e.target.value as DeepAgentPermissionAction,
                    )
                  }
                >
                  {redLine ? (
                    <>
                      <option value="ask">{ACTION_LABELS.ask}</option>
                      <option value="deny">{ACTION_LABELS.deny}</option>
                    </>
                  ) : (
                    <>
                      <option value="allow">{ACTION_LABELS.allow}</option>
                      <option value="ask">{ACTION_LABELS.ask}</option>
                      <option value="deny">{ACTION_LABELS.deny}</option>
                    </>
                  )}
                </select>
                {redLine && (
                  <span className="ml-2 text-[10px] text-red-400">红线</span>
                )}
              </td>
              <td className="px-3 py-2 text-xs">
                {isOwn ? (
                  <span className="text-gray-500">本层</span>
                ) : (
                  <span className={SOURCE_COLORS[source]}>
                    {SOURCE_LABELS[source]}
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function TrustedDirsEditor({
  draft,
  onChange,
}: {
  draft: DeepAgentPermissionConfig;
  onChange: (dirs: string[]) => void;
}) {
  const [newDir, setNewDir] = useState("");
  const dirs = draft.trustedDirs ?? [];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          className="w-72 rounded border border-gray-600 bg-gray-800 px-2 py-1 text-xs text-gray-100"
          placeholder="输入绝对路径，如 D:/code/demo"
          value={newDir}
          onChange={(e) => setNewDir(e.target.value)}
        />
        <button
          className="rounded bg-gray-700 px-3 py-1 text-xs text-gray-100 hover:bg-gray-600"
          onClick={() => {
            const v = newDir.trim();
            if (!v || dirs.includes(v)) return;
            onChange([...dirs, v]);
            setNewDir("");
          }}
        >
          添加
        </button>
      </div>
      {dirs.map((d, i) => (
        <div key={`${d}-${i}`} className="flex items-center gap-2 text-xs">
          <span className="text-gray-300">{d}</span>
          <button
            className="text-red-400 hover:text-red-300"
            onClick={() => onChange(dirs.filter((_, idx) => idx !== i))}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Editor for the `execute` allowlist: a list of programs (or `/regex/`
 * patterns) that may run WITHOUT the approval card. Matching is by the
 * command's first token and only when the command contains no shell
 * metacharacters, so a trusted prefix cannot be turned into a chained command.
 */
function ExecuteAllowlistEditor({
  value,
  onChange,
}: {
  value: string[];
  onChange: (entries: string[]) => void;
}) {
  const [newEntry, setNewEntry] = useState("");
  const entries = value ?? [];
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-gray-400">
        列出可免审批直接执行的程序（如{" "}
        <span className="font-mono text-gray-200">mvn</span>、{" "}
        <span className="font-mono text-gray-200">tsc</span>、{" "}
        <span className="font-mono text-gray-200">npm run build</span>
        ）。匹配命令的
        <b>首个程序</b>，且命令不含 shell 元字符（; | &amp; &lt; &gt; $ ` (
        )）时才免审批。
      </p>
      <div className="flex gap-2">
        <input
          className="w-80 rounded border border-gray-600 bg-gray-800 px-2 py-1 text-xs text-gray-100"
          placeholder="程序名或 /正则/，如 mvn 或 /^npm run test$/"
          value={newEntry}
          onChange={(e) => setNewEntry(e.target.value)}
        />
        <button
          className="rounded bg-gray-700 px-3 py-1 text-xs text-gray-100 hover:bg-gray-600"
          onClick={() => {
            const v = newEntry.trim();
            if (!v || entries.includes(v)) return;
            onChange([...entries, v]);
            setNewEntry("");
          }}
        >
          添加
        </button>
      </div>
      {entries.length === 0 ? (
        <span className="text-xs text-gray-500">（空：所有命令都需审批）</span>
      ) : (
        entries.map((d, i) => (
          <div key={`${d}-${i}`} className="flex items-center gap-2 text-xs">
            <span className="font-mono text-gray-300">{d}</span>
            <button
              className="text-red-400 hover:text-red-300"
              onClick={() => onChange(entries.filter((_, idx) => idx !== i))}
            >
              ✕
            </button>
          </div>
        ))
      )}
    </div>
  );
}

export function PermissionsSection() {
  const ideMessenger = useContext(IdeMessengerContext);
  const [state, setState] = useState<DeepAgentPermissionsState | null>(null);
  const [layer, setLayer] = useState<LayerKey>("global");
  const [draft, setDraft] = useState<
    Record<"global" | "workspace", DeepAgentPermissionConfig>
  >({ global: {}, workspace: {} });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const applyState = (s: DeepAgentPermissionsState) => {
    setState(s);
    setDraft({ global: clone(s.global), workspace: clone(s.workspace) });
  };

  useEffect(() => {
    ideMessenger
      .request("deepAgent/permissions/getState", undefined)
      .then((msg) => {
        if (msg.status === "success") applyState(msg.content);
        else setError(msg.error);
      })
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRuleChange = (
    scope: "trustRules" | "untrustRules",
    tool: string,
    action: DeepAgentPermissionAction,
  ) => {
    if (layer === "session") return;
    setDraft((prev) => {
      const cfg = prev[layer];
      const rules = cfg[scope] ?? [];
      const idx = rules.findIndex((r) => r.tool === tool);
      const next = [...rules];
      if (idx >= 0) next[idx] = { tool, action };
      else next.push({ tool, action });
      return { ...prev, [layer]: { ...cfg, [scope]: next } };
    });
  };

  const handleDirsChange = (dirs: string[]) => {
    if (layer === "session") return;
    setDraft((prev) => ({
      ...prev,
      [layer]: { ...prev[layer], trustedDirs: dirs },
    }));
  };

  const handleAllowlistChange = (entries: string[]) => {
    if (layer === "session") return;
    setDraft((prev) => ({
      ...prev,
      [layer]: { ...prev[layer], executeAllowlist: entries },
    }));
  };

  const saveLayer = async () => {
    if (layer === "session") return;
    setSaving(true);
    setError(null);
    try {
      const msg = await ideMessenger.request(
        "deepAgent/permissions/updateLayer",
        {
          layer,
          config: draft[layer],
        },
      );
      if (msg.status === "success") applyState(msg.content);
      else setError(msg.error);
    } catch (e) {
      setError(String(e));
    }
    setSaving(false);
  };

  const clearSession = async () => {
    setError(null);
    try {
      const msg = await ideMessenger.request(
        "deepAgent/permissions/clearSession",
        undefined,
      );
      if (msg.status === "success") applyState(msg.content);
      else setError(msg.error);
    } catch (e) {
      setError(String(e));
    }
  };

  if (error) {
    return (
      <div>
        <ConfigHeader title="权限" />
        <p className="text-sm text-red-400">加载失败：{error}</p>
      </div>
    );
  }

  if (!state) {
    // Render the chrome immediately so the page never looks blank while the
    // IDE resolves the permission state.
    return (
      <div className="flex flex-col gap-6">
        <ConfigHeader title="权限" />
        <div className="flex gap-2">
          {LAYER_TABS.map((t) => (
            <button
              key={t.id}
              className={`rounded-full px-4 py-1.5 text-xs ${
                layer === t.id
                  ? "bg-violet-600 text-white"
                  : "bg-gray-800 text-gray-400"
              }`}
              onClick={() => setLayer(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <Card>
          <p className="text-xs text-gray-400">加载中…</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <ConfigHeader title="权限" />

      {/* Layer tabs */}
      <div className="flex gap-2">
        {LAYER_TABS.map((t) => (
          <button
            key={t.id}
            className={`rounded-full px-4 py-1.5 text-xs transition-colors ${
              layer === t.id
                ? "bg-violet-600 text-white"
                : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
            }`}
            onClick={() => setLayer(t.id)}
          >
            {t.label}
          </button>
        ))}
        <button
          className="ml-auto rounded border border-gray-600 px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200"
          onClick={() =>
            ideMessenger
              .request("deepAgent/permissions/getState", undefined)
              .then((msg) => {
                if (msg.status === "success") applyState(msg.content);
              })
          }
        >
          刷新
        </button>
      </div>

      {/* Merged preview (read-only) */}
      <Card>
        <div className="flex flex-col gap-1 text-xs text-gray-400">
          <span className="font-medium text-gray-200">合并预览（只读）</span>
          <span>
            工作区文件夹：
            {state.workspaceFolders.length
              ? state.workspaceFolders.join("、")
              : "（无）"}
          </span>
          <span>
            额外信任目录：
            {state.merged.trustedDirs.length
              ? state.merged.trustedDirs.join("、")
              : "（无）"}
          </span>
          <span>
            命令免审批白名单（execute）：
            {state.merged.executeAllowlist.length
              ? state.merged.executeAllowlist.join("、")
              : "（空：所有命令需审批）"}
          </span>
          <span>兜底：未知工具默认「需要审批」</span>
        </div>
      </Card>

      {layer === "session" ? (
        <>
          <div>
            <ConfigHeader title="已批准路径（allow）" variant="sm" />
            <Card>
              <div className="flex flex-col gap-1 text-xs">
                {state.session.approved.length === 0 ? (
                  <span className="text-gray-500">（无）</span>
                ) : (
                  state.session.approved.map((p, i) => (
                    <span
                      key={`${p}-${i}`}
                      className="break-all text-emerald-400"
                    >
                      ✅ {p}
                    </span>
                  ))
                )}
              </div>
            </Card>
          </div>
          <div>
            <ConfigHeader title="已拒绝路径（deny）" variant="sm" />
            <Card>
              <div className="flex flex-col gap-1 text-xs">
                {state.session.denied.length === 0 ? (
                  <span className="text-gray-500">（无）</span>
                ) : (
                  state.session.denied.map((p, i) => (
                    <span key={`${p}-${i}`} className="break-all text-red-400">
                      🚫 {p}
                    </span>
                  ))
                )}
              </div>
            </Card>
          </div>
          <div className="flex items-center gap-3">
            <button
              className="rounded border border-red-500/50 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10"
              onClick={clearSession}
            >
              清空本次会话记忆
            </button>
            <span className="text-xs text-gray-500">
              清空后所有路径重新按全局/项目策略判定（强制重算）
            </span>
          </div>
        </>
      ) : (
        <>
          <div>
            <ConfigHeader title="受信任目录内规则" variant="sm" />
            <Card>
              <RuleTable
                scope="trustRules"
                layer={layer}
                draft={draft[layer]}
                merged={state.merged.trustRules}
                onChange={handleRuleChange}
              />
            </Card>
          </div>
          <div>
            <ConfigHeader title="非受信任目录内规则" variant="sm" />
            <Card>
              <RuleTable
                scope="untrustRules"
                layer={layer}
                draft={draft[layer]}
                merged={state.merged.untrustRules}
                onChange={handleRuleChange}
              />
              <p className="mt-3 text-xs text-red-400">
                安全红线：非信任目录的文件类工具不可设为「无需审批」。
              </p>
            </Card>
          </div>
          <div>
            <ConfigHeader title="受信任目录管理" variant="sm" />
            <Card>
              <TrustedDirsEditor
                draft={draft[layer]}
                onChange={handleDirsChange}
              />
            </Card>
          </div>
          <div>
            <ConfigHeader title="命令免审批白名单（execute）" variant="sm" />
            <Card>
              <ExecuteAllowlistEditor
                value={draft[layer].executeAllowlist ?? []}
                onChange={handleAllowlistChange}
              />
            </Card>
          </div>
          <div className="flex items-center gap-3">
            <button
              className="rounded bg-violet-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-50"
              disabled={saving}
              onClick={saveLayer}
            >
              {saving ? "保存中…" : "💾 保存本层"}
            </button>
            <span className="text-xs text-gray-500">
              {layer === "workspace"
                ? "写入工作区设置（.vscode/settings.json 或 .code-workspace）"
                : "写入用户设置（User settings.json）"}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
