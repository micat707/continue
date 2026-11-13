import { useEffect } from "react";

const LIGHTBOX_CLASS = "kiro-image-lightbox";

// Shows the full-size image in a dismissible overlay on top of the webview.
export function openImageLightbox(src: string) {
  document.querySelector(`.${LIGHTBOX_CLASS}`)?.remove();

  const overlay = document.createElement("div");
  overlay.className = LIGHTBOX_CLASS;

  const image = document.createElement("img");
  image.src = src;
  image.alt = "";
  overlay.appendChild(image);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      close();
    }
  };

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKeyDown);
  };

  overlay.addEventListener("click", close);
  document.addEventListener("keydown", onKeyDown);
  document.body.appendChild(overlay);
}

// Images inside `scopeSelector` (e.g. a user message bubble) are rendered as
// thumbnails; clicking one opens the full-size image instead.
export function useImageZoom(
  containerRef: { readonly current: HTMLElement | null },
  scopeSelector: string,
) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    // Returns the scoped image under the pointer, or null.
    const getScopedImage = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLImageElement)) {
        return null;
      }
      return target.closest(scopeSelector) ? target : null;
    };

    // Block ProseMirror from selecting the image / placing a caret on it.
    const onMouseDown = (event: MouseEvent) => {
      if (!getScopedImage(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };

    const onClick = (event: MouseEvent) => {
      if (event.button !== 0) {
        return;
      }

      const image = getScopedImage(event);
      if (!image) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      openImageLightbox(image.src);
    };

    container.addEventListener("mousedown", onMouseDown, true);
    container.addEventListener("click", onClick, true);
    return () => {
      container.removeEventListener("mousedown", onMouseDown, true);
      container.removeEventListener("click", onClick, true);
    };
  }, [containerRef, scopeSelector]);
}
