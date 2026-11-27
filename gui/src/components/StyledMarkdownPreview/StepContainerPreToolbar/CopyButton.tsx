import useCopy from "../../../hooks/useCopy";
import { ToolTip } from "../../gui/Tooltip";
import HoverItem from "../../mainInput/InputToolbar/HoverItem";

interface CopyButtonProps {
  text: string;
}

export function CopyButton({ text }: CopyButtonProps) {
  const { copyText, copied } = useCopy(text);

  return (
    <ToolTip place="top" content="Copy Code">
      <HoverItem className="!p-0">
        <div
          className="text-lightgray flex cursor-pointer items-center border-none bg-transparent text-xs outline-none hover:brightness-125"
          onClick={copyText}
        >
          <div className="flex items-center gap-1 transition-colors duration-200 hover:brightness-125">
            {copied ? (
              <i className="kiro-icon codicon codicon-check text-green-500" />
            ) : (
              <i className="kiro-icon codicon codicon-copy" />
            )}
          </div>
        </div>
      </HoverItem>
    </ToolTip>
  );
}
