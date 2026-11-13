import { useContext, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { Button } from "../../components/ui";
import { PageHeader } from "../../components/PageHeader";
import { BRAND_WORKSPACE_DIR } from "../../util/brand";

type FeatureKey = "steering" | "specs" | "hooks" | "power";

interface SteeringTemplate {
  label: string;
  filename: string;
  content: string;
}

// Maps a feature to its deep-link URI scheme, mirroring the handler registered
// in extensions/vscode/src/activation/activate.ts (micat-spec://, etc.).
const SCHEME_BY_FEATURE: Record<FeatureKey, string> = {
  steering: "micat-steering",
  specs: "micat-spec",
  hooks: "micat-hooks",
  power: "micat-power",
};

interface WorkspaceFilesPageProps {
  featureKey: FeatureKey;
  title: string;
  description: string;
  fileExt?: string;
  template?: string;
  templates?: SteeringTemplate[];
}

/**
 * Shared CRUD UI for the MicatCode "Workspace" features (Steering/Specs/Hooks/Power).
 * Each feature is a folder of Markdown files under `<workspace>/.micat/<feature>/`.
 * This mirrors how Kiro keeps `.kiro/steering`, `.kiro/specs`, etc. on disk.
 * All IO goes through the existing ideMessenger.ide file protocol
 * (getWorkspaceDirs / createDirectory / listDir / readFile / writeFile / removeFile).
 */
export default function WorkspaceFilesPage({
  featureKey,
  title,
  description,
  fileExt = ".md",
  template = "# New entry\n\n",
  templates,
}: WorkspaceFilesPageProps) {
  const ideMessenger = useContext(IdeMessengerContext);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [dirUri, setDirUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showTplMenu, setShowTplMenu] = useState(false);
  const [copiedName, setCopiedName] = useState<string | null>(null);

  async function refresh(dir: string) {
    try {
      const entries = await ideMessenger.ide.listDir(dir);
      const names = entries
        .filter(([name]) => name.endsWith(fileExt))
        .map(([name]) => name);
      setFiles(names);
    } catch {
      setFiles([]);
    }
  }

  useEffect(() => {
    (async () => {
      setError(null);
      try {
        const dirs = await ideMessenger.ide.getWorkspaceDirs();
        if (!dirs.length) {
          setError("No workspace folder is open.");
          return;
        }
        const dir = `${dirs[0]}/${BRAND_WORKSPACE_DIR}/${featureKey}`;
        setDirUri(dir);
        try {
          await ideMessenger.ide.createDirectory(dir);
        } catch {
          /* directory already exists */
        }
        await refresh(dir);
      } catch (e) {
        setError(String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featureKey]);

  // Deep-link support: ?name=<file> auto-selects the matching file.
  // Driven by micat-spec://, micat-steering://, etc. URI handlers.
  useEffect(() => {
    const name = searchParams.get("name");
    if (!name || !dirUri || files.length === 0) {
      return;
    }
    const match = files.find(
      (f) =>
        f === name ||
        f === `${name}${fileExt}` ||
        f.replace(/\.md$/, "") === name,
    );
    if (match && match !== selected) {
      void onSelect(match);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, searchParams]);

  async function onSelect(name: string) {
    if (!dirUri) {
      return;
    }
    setBusy(true);
    try {
      const text = await ideMessenger.ide.readFile(`${dirUri}/${name}`);
      setSelected(name);
      setContent(text);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onNew() {
    if (!dirUri) {
      return;
    }
    const input = window.prompt(
      `New ${featureKey} file name`,
      `my-${featureKey}${fileExt}`,
    );
    if (!input) {
      return;
    }
    const fname = input.endsWith(fileExt) ? input : `${input}${fileExt}`;
    setSelected(fname);
    setContent(template);
  }

  // Create a new file pre-filled from a template (Kiro-style "new from template").
  function createFromTemplate(tpl: SteeringTemplate) {
    if (!dirUri) {
      return;
    }
    const fname = tpl.filename.endsWith(fileExt)
      ? tpl.filename
      : `${tpl.filename}${fileExt}`;
    setSelected(fname);
    setContent(tpl.content);
    setShowTplMenu(false);
  }

  // Reverse deep link: copy micat-<feature>://<name> so it can be reopened
  // via the registered URI handler (mirrors Kiro's "copy link" on specs).
  async function copyLink(name: string) {
    const base = name.replace(/\.md$/, "");
    const link = `${SCHEME_BY_FEATURE[featureKey]}://${base}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopiedName(name);
      setTimeout(() => setCopiedName((n) => (n === name ? null : n)), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  async function onSave() {
    if (!dirUri || !selected) {
      return;
    }
    setBusy(true);
    try {
      await ideMessenger.ide.writeFile(`${dirUri}/${selected}`, content);
      await refresh(dirUri);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!dirUri || !selected) {
      return;
    }
    if (!window.confirm(`Delete ${selected}?`)) {
      return;
    }
    setBusy(true);
    try {
      await ideMessenger.ide.removeFile(`${dirUri}/${selected}`);
      setSelected(null);
      setContent("");
      await refresh(dirUri);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", height: "100%", padding: "0.5rem" }}>
      <div
        style={{
          width: "32%",
          borderRight: "1px solid var(--vsc-input-border, #444)",
          paddingRight: "0.5rem",
          overflowY: "auto",
        }}
      >
        <PageHeader
          title={title}
          onTitleClick={() => navigate("/")}
          showBorder
        />
        <p
          style={{
            fontSize: "0.75rem",
            color: "var(--vsc-descriptionForeground, #888)",
            marginTop: "0.5rem",
          }}
        >
          {description}
        </p>
        <div style={{ position: "relative", display: "inline-block" }}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              templates ? setShowTplMenu((v) => !v) : void onNew()
            }
          >
            ＋ New
          </Button>
          {templates && showTplMenu && (
            <div
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                marginTop: "0.25rem",
                background: "var(--vsc-input-background, #1e1e1e)",
                border: "1px solid var(--vsc-input-border, #444)",
                borderRadius: "4px",
                zIndex: 10,
                minWidth: "13rem",
              }}
            >
              {templates.map((tpl) => (
                <div
                  key={tpl.filename}
                  onClick={() => createFromTemplate(tpl)}
                  style={{
                    padding: "0.4rem 0.6rem",
                    cursor: "pointer",
                  }}
                >
                  {tpl.label}
                </div>
              ))}
              <div
                onClick={() => {
                  setShowTplMenu(false);
                  void onNew();
                }}
                style={{
                  padding: "0.4rem 0.6rem",
                  cursor: "pointer",
                  borderTop: "1px solid var(--vsc-input-border, #444)",
                }}
              >
                Custom...
              </div>
            </div>
          )}
        </div>
        <ul style={{ listStyle: "none", padding: 0, marginTop: "0.5rem" }}>
          {files.map((f) => (
            <li
              key={f}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.25rem",
              }}
            >
              <button
                onClick={() => onSelect(f)}
                style={{
                  flex: 1,
                  textAlign: "left",
                  background:
                    f === selected
                      ? "var(--vsc-input-background, #333)"
                      : "transparent",
                  border: "none",
                  color: "var(--vsc-foreground, #ddd)",
                  padding: "0.35rem 0.5rem",
                  cursor: "pointer",
                  borderRadius: "4px",
                }}
              >
                {f}
              </button>
              <button
                onClick={() => copyLink(f)}
                title="Copy deep link"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--vsc-descriptionForeground, #888)",
                  cursor: "pointer",
                  fontSize: "0.8rem",
                  padding: "0.2rem 0.35rem",
                  borderRadius: "4px",
                }}
              >
                {copiedName === f ? "✓" : "🔗"}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          paddingLeft: "0.5rem",
        }}
      >
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem" }}>
          <Button
            variant="secondary"
            size="sm"
            onClick={onSave}
            disabled={!selected || busy}
          >
            Save
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onDelete}
            disabled={!selected || busy}
          >
            Delete
          </Button>
          {selected && (
            <span
              style={{
                alignSelf: "center",
                fontSize: "0.75rem",
                color: "var(--vsc-descriptionForeground, #888)",
              }}
            >
              {selected}
            </span>
          )}
        </div>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          disabled={!selected}
          style={{
            flex: 1,
            width: "100%",
            resize: "none",
            background: "var(--vsc-input-background, #1e1e1e)",
            color: "var(--vsc-foreground, #ddd)",
            border: "1px solid var(--vsc-input-border, #444)",
            borderRadius: "4px",
            padding: "0.5rem",
            fontFamily: "monospace",
            fontSize: "0.8rem",
          }}
        />
        {error && (
          <div
            style={{
              color: "#f87171",
              fontSize: "0.75rem",
              marginTop: "0.5rem",
            }}
          >
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
