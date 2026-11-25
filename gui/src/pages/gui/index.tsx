import { History } from "../../components/History";
import ArtifactPanel from "../../components/ArtifactPanel/ArtifactPanel";
import { Chat } from "./Chat";

export default function GUI() {
  return (
    <div className="flex min-h-0 w-full flex-row overflow-x-clip">
      <aside className="4xl:flex border-vsc-input-border no-scrollbar hidden min-h-0 w-96 overflow-y-auto border-0 border-r border-solid">
        <History />
      </aside>
      <main className="no-scrollbar relative flex min-h-0 min-w-0 flex-1 flex-col">
        <Chat />
      </main>
      <ArtifactPanel />
    </div>
  );
}
