import { XMarkIcon } from "@heroicons/react/24/outline";
import { NewSessionButton } from "./NewSessionButton.js";
import React, {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useDispatch, useSelector } from "react-redux";
import styled from "styled-components";
import { Session } from "core";
import { renderChatMessage } from "core/util/messageContent";
import { defaultBorderRadius } from "..";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { newSession } from "../../redux/slices/sessionSlice";
import {
  addTab,
  handleSessionChange,
  removeTab,
  setActiveTab,
  setTabs,
  updateTab,
  Tab as TabType,
} from "../../redux/slices/tabsSlice";
import { AppDispatch, RootState } from "../../redux/store";
import {
  getSession,
  loadSession,
  saveCurrentSession,
  updateSession,
} from "../../redux/thunks/session";
import { varWithFallback } from "../../styles/theme";

// Haven't set up theme colors for tabs yet
// Will keep it simple and choose from existing ones. Comments show vars we could use
const tabBorderVar = varWithFallback("border"); // --vscode-tab-border
const tabBackgroundVar = varWithFallback("background"); // --vscode-tab-inactiveBackground
const tabForegroundVar = varWithFallback("foreground"); // --vscode-tab-inactiveForeground
const tabHoverBackgroundVar = varWithFallback("list-hover"); // --vscode-tab-hoverBackground
const tabHoverForegroundVar = varWithFallback("foreground"); // --vscode-tab-hoverForeground
const tabSelectedBackgroundVar = varWithFallback("background"); // --vscode-tab-activeBackground
const tabSelectedForegroundVar = varWithFallback("foreground"); // --vscode-tab-activeForeground
const tabAccentVar = varWithFallback("accent"); // --vscode-tab-activeBorderTop

const TabBarContainer = styled.div`
  display: flex;
  flex-wrap: wrap;
  flex-shrink: 0;
  flex-grow: 0;
  background-color: ${tabBackgroundVar};
  border-bottom: none;
  position: relative;
  margin-top: 2px;
  max-height: 100px;
  overflow: auto;

  /* Hide scrollbar but keep functionality */
  scrollbar-width: none;
  &::-webkit-scrollbar {
    display: none;
  }
`;

const Tab = styled.div<{ isActive: boolean }>`
  display: flex;
  align-items: center;
  box-sizing: border-box;
  padding: 0 5px 0 12px;
  flex-grow: 1;
  width: 100px;
  max-width: 150px;
  height: 25px;
  background-color: ${(props) =>
    props.isActive ? tabSelectedBackgroundVar : tabBackgroundVar};
  color: ${(props) =>
    props.isActive ? tabSelectedForegroundVar : tabForegroundVar};
  cursor: pointer;
  border: 1px solid ${tabBorderVar};
  border-bottom: ${(props) =>
    props.isActive ? "none" : `1px solid ${tabBorderVar}`};
  user-select: none;
  position: relative;
  transition: background-color 0.2s;
  border-top: ${(props) =>
    props.isActive ? `1px solid ${tabAccentVar}` : `1px solid ${tabBorderVar}`};
  &:first-child {
    border-left: none;
  }
  & + & {
    border-left: none;
  }

  &:hover {
    background-color: ${(props) =>
      props.isActive ? tabSelectedBackgroundVar : tabHoverBackgroundVar};
    color: ${(props) =>
      props.isActive ? tabSelectedForegroundVar : tabHoverForegroundVar};
  }
`;

const TabTitle = styled.span`
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
`;

const CloseButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-left: 4px;
  border: none;
  background: transparent;
  color: inherit;
  opacity: 0.7;
  cursor: pointer;
  border-radius: ${defaultBorderRadius};
  padding: 2px;
  visibility: hidden;

  &:hover {
    opacity: 1;
    background-color: ${tabHoverBackgroundVar};
  }

  ${Tab}:hover & {
    visibility: visible;
  }

  &[disabled] {
    display: none !important;
  }
`;

const TabBarSpace = styled.div`
  flex: 1;
  display: flex;
  border-bottom: 1px solid ${tabBorderVar};
  background-color: ${tabBackgroundVar};
`;

// ---- Kiro-style tab context menu ----
const ContextMenu = styled.div`
  position: fixed;
  z-index: 1000;
  min-width: 190px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  background: var(--vscode-menu-background, #28242e);
  border: 1px solid
    var(--vscode-menu-separatorBackground, rgba(255, 255, 255, 0.2));
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
  font-size: 12px;
`;

const MenuItem = styled.div<{ disabled?: boolean }>`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 5px 10px;
  border-radius: 4px;
  white-space: nowrap;
  color: var(--vscode-menu-foreground, #f0f0f0);
  cursor: ${(props) => (props.disabled ? "default" : "pointer")};
  opacity: ${(props) => (props.disabled ? 0.45 : 1)};

  &:hover {
    background: ${(props) =>
      props.disabled
        ? "transparent"
        : "var(--vscode-menu-selectionBackground, #352f3d)"};
  }

  .menu-shortcut {
    color: var(--vscode-descriptionForeground, rgba(255, 255, 255, 0.6));
    margin-left: auto;
    padding-left: 16px;
  }
`;

const MenuDivider = styled.div`
  height: 1px;
  margin: 4px 6px;
  background: var(--vscode-menu-separatorBackground, rgba(255, 255, 255, 0.2));
`;

const RenameInput = styled.input`
  flex: 1;
  min-width: 0;
  height: 18px;
  padding: 0 4px;
  font-size: 12px;
  color: var(--vscode-input-foreground, #fff);
  background: var(--vscode-input-background, #211d25);
  border: 1px solid var(--vscode-focusBorder, #9e61ff);
  border-radius: 3px;
  outline: none;
`;

export const TabBar = React.forwardRef<HTMLDivElement>((_, ref) => {
  const dispatch = useDispatch<AppDispatch>();
  const ideMessenger = useContext(IdeMessengerContext);
  const currentSessionId = useSelector((state: RootState) => state.session.id);
  const currentSessionTitle = useSelector(
    (state: RootState) => state.session.title,
  );
  const hasHistory = useSelector(
    (state: RootState) => state.session.history.length > 0,
  );
  const tabs = useSelector((state: RootState) => state.tabs.tabs);

  // Right-click context menu state
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    tabId: string;
  } | null>(null);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  // Simple UUID generator for our needs
  const generateId = useCallback(() => {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
  }, []);

  useEffect(() => {
    if (!currentSessionId) return;

    dispatch(
      handleSessionChange({
        currentSessionId,
        currentSessionTitle,
        newTabId: generateId(), // Pass the ID generator result
      }),
    );
  }, [currentSessionId, currentSessionTitle]);

  // Close the context menu on outside click or Escape
  useEffect(() => {
    if (!menu) return;
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(null);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menu]);

  const handleNewTab = async () => {
    // Save current session before creating new one
    if (hasHistory) {
      await dispatch(
        saveCurrentSession({ openNewSession: false, generateTitle: true }),
      );
    }

    dispatch(newSession());

    dispatch(
      addTab({
        id: generateId(),
        title: `Chat ${tabs.length + 1}`,
        isActive: true,
        sessionId: undefined,
      }),
    );
  };

  useEffect(() => {
    if (!tabs.length) {
      handleNewTab();
    }
  }, [tabs.map((t) => t.id).join(",")]);

  const handleTabClick = async (id: string) => {
    const targetTab = tabs.find((tab) => tab.id === id);
    if (!targetTab) return;

    if (targetTab.sessionId) {
      // Switch to existing session
      await dispatch(
        loadSession({
          sessionId: targetTab.sessionId,
          saveCurrentSession: hasHistory,
        }),
      );
    }

    dispatch(setActiveTab(id));
  };

  const handleTabClose = async (id: string) => {
    //if (tabs.length <= 1) return;

    const isClosingActive = tabs.find((t) => t.id === id)?.isActive;
    const filtered = tabs.filter((t) => t.id !== id);

    if (isClosingActive) {
      const lastTab = filtered[filtered.length - 1];
      if (filtered.length) {
        await handleTabClick(lastTab.id);
        dispatch(
          setTabs(
            filtered.map((tab, i) => ({
              ...tab,
              isActive: i === filtered.length - 1,
            })),
          ),
        );
      } else {
        dispatch(setTabs([]));
        dispatch(newSession());
      }
    } else {
      dispatch(removeTab(id));
    }
  };

  // ---- Kiro-style context menu actions ----
  const openTabMenu = (e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, tabId });
  };

  const closeOtherTabs = async (id: string) => {
    const target = tabs.find((t) => t.id === id);
    if (!target) return;
    const wasActive = tabs.some((t) => t.isActive && t.id === id);
    dispatch(
      setTabs(
        tabs.filter((t) => t.id === id).map((t) => ({ ...t, isActive: true })),
      ),
    );
    if (!wasActive && target.sessionId) {
      await dispatch(
        loadSession({
          sessionId: target.sessionId,
          saveCurrentSession: hasHistory,
        }),
      );
    }
  };

  const beginRename = (tab: TabType) => {
    setRenamingTabId(tab.id);
    setRenameValue(tab.title);
    setMenu(null);
  };

  const commitRename = async () => {
    const id = renamingTabId;
    setRenamingTabId(null);
    if (!id) return;
    const title = renameValue.trim();
    if (!title) return;
    const tab = tabs.find((t) => t.id === id);
    if (!tab || tab.title === title) return;
    dispatch(updateTab({ id, updates: { title } }));
    if (tab.sessionId) {
      // Persist the new title on the underlying session too
      try {
        const session = await getSession(ideMessenger, tab.sessionId);
        void dispatch(updateSession({ ...session, title }));
      } catch (e) {
        console.error("Failed to rename session:", e);
      }
    }
  };

  const sessionToMarkdown = (session: Session): string => {
    const parts: string[] = [`# ${session.title}`, ""];
    for (const item of session.history) {
      const role = item.message.role === "user" ? "User" : "Assistant";
      parts.push(`## ${role}`, "", renderChatMessage(item.message) || "", "");
    }
    return parts.join("\n");
  };

  const getSessionMarkdown = async (tab: TabType): Promise<string | null> => {
    if (!tab.sessionId) return null;
    try {
      const session = await getSession(ideMessenger, tab.sessionId);
      return sessionToMarkdown(session);
    } catch (e) {
      console.error("Failed to load session:", e);
      return null;
    }
  };

  const openSessionInEditor = async (tab: TabType) => {
    setMenu(null);
    const markdown = await getSessionMarkdown(tab);
    if (markdown === null) return;
    ideMessenger.post("showVirtualFile", {
      name: `${tab.title}.md`,
      content: markdown,
    });
  };

  const exportSessionToDisk = async (tab: TabType) => {
    setMenu(null);
    const markdown = await getSessionMarkdown(tab);
    if (markdown === null) return;
    try {
      const result = await ideMessenger.request("exportSession", {
        name: `${tab.title}.md`,
        content: markdown,
      });
      if (result.status === "success" && result.content) {
        void ideMessenger.ide.showToast(
          "info",
          `Chat exported to ${result.content}`,
        );
      }
    } catch (e) {
      console.error("Failed to export session:", e);
    }
  };

  return (
    <TabBarContainer
      ref={ref}
      style={{
        // 上游逻辑是"只有 1 个标签时隐藏整个标签栏"（省空间），但副作用是
        // 单会话时看不到已生成的会话标题。改为始终显示。
        display: "flex",
      }}
    >
      {tabs.map((tab) => (
        <Tab
          key={tab.id}
          isActive={tab.isActive}
          onClick={() => handleTabClick(tab.id)}
          onContextMenu={(e) => openTabMenu(e, tab.id)}
          onAuxClick={(e) => {
            // Middle mouse button
            if (e.button === 1) {
              e.preventDefault();
              handleTabClose(tab.id);
            }
          }}
        >
          {renamingTabId === tab.id ? (
            <RenameInput
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commitRename();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setRenamingTabId(null);
                }
              }}
            />
          ) : (
            <TabTitle>{tab.title}</TabTitle>
          )}
          <CloseButton
            disabled={renamingTabId === tab.id}
            onClick={(e) => {
              e.stopPropagation();
              handleTabClose(tab.id);
            }}
          >
            <XMarkIcon width={12} height={12} />
          </CloseButton>
        </Tab>
      ))}
      <TabBarSpace>
        <NewSessionButton onClick={handleNewTab} />
      </TabBarSpace>
      {menu &&
        (() => {
          const menuTab = tabs.find((t) => t.id === menu.tabId);
          if (!menuTab) return null;
          const left = Math.min(menu.x, window.innerWidth - 210);
          const top = Math.min(menu.y, window.innerHeight - 230);
          return (
            <ContextMenu
              ref={menuRef}
              style={{ left, top }}
              onClick={(e) => e.stopPropagation()}
            >
              <MenuItem
                onClick={() => {
                  setMenu(null);
                  void handleTabClose(menuTab.id);
                }}
              >
                <span>Close</span>
                <span className="menu-shortcut">Ctrl+W</span>
              </MenuItem>
              <MenuItem
                disabled={tabs.length <= 1}
                onClick={() => {
                  setMenu(null);
                  void closeOtherTabs(menuTab.id);
                }}
              >
                <span>Close Other Tabs</span>
              </MenuItem>
              <MenuDivider />
              <MenuItem onClick={() => beginRename(menuTab)}>
                <span>Rename</span>
              </MenuItem>
              <MenuItem
                disabled={!menuTab.sessionId}
                onClick={() => void openSessionInEditor(menuTab)}
              >
                <span>Open in Editor</span>
              </MenuItem>
              <MenuItem
                disabled={!menuTab.sessionId}
                onClick={() => void exportSessionToDisk(menuTab)}
              >
                <span>Export Chat</span>
              </MenuItem>
            </ContextMenu>
          );
        })()}
    </TabBarContainer>
  );
});
