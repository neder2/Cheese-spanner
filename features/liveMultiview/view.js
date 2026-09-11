/** 멀티뷰 DOM 요소와 신뢰된 조작 바인딩. isolated world 전용. */
(() => {
    const root = (window.BetterChzzk = window.BetterChzzk || {});
    const controlActions = new WeakMap();
    function text(node, value) {
        if (node && node.textContent !== value) node.textContent = value;
    }
    function el(tag, className, value) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (value) node.textContent = value;
        return node;
    }
    function button(label, action, id) {
        const node = el("button", "", label);
        node.type = "button";
        node.dataset.action = action;
        if (id) node.dataset.channel = id;
        controlActions.set(node, { action, channel: id });
        return node;
    }
    function delayButton(delta, id) {
        const control = button(`${delta < 0 ? "−" : "+"}${Math.abs(delta)}s`, "delay", id);
        control.dataset.delta = String(delta);
        controlActions.set(control, { action: "delay", channel: id, delta });
        control.setAttribute("aria-label", `싱크 ${delta < 0 ? "앞으로" : "늦추기"} ${Math.abs(delta)}s`);
        return control;
    }
    function panelIcon(kind) {
        const paths = {
            add: "M8 3v10M3 8h10",
            close: "m4 4 8 8M12 4l-8 8",
            layout: "M2 2.5h7v11H2zM11.5 2.5H14v4h-2.5zM11.5 9.5H14v4h-2.5z",
            align: "M2 2.5h12v3H2zM2 10.5h12v3H2zM5 8h6",
            remove: "M3 4.5h10M6 2.5h4M4 4.5l.5 9h7l.5-9M6.5 7v4M9.5 7v4",
        };
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"),
            path = document.createElementNS(svg.namespaceURI, "path");
        svg.classList.add("bcmv-panel-icon");
        svg.setAttribute("viewBox", "0 0 16 16");
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("focusable", "false");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "1.5");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        path.setAttribute("d", paths[kind]);
        svg.append(path);
        return svg;
    }
    function multiviewIcon() {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "1.6");
        for (const [x, y, width, height] of [
            [3, 3, 11, 11],
            [17, 3, 4, 4],
            [17, 10, 4, 4],
            [3, 17, 4, 4],
            [10, 17, 4, 4],
            [17, 17, 4, 4],
        ]) {
            const rect = document.createElementNS(svg.namespaceURI, "rect");
            for (const [name, value] of Object.entries({ x, y, width, height, rx: 0.6 }))
                rect.setAttribute(name, String(value));
            svg.append(rect);
        }
        return svg;
    }
    function setControlIcon(node, kind, label) {
        if (!node) return;
        node.setAttribute("aria-label", label);
        if (node.dataset.icon === kind) return;
        node.dataset.icon = kind;
        // Playback/volume glyphs measured on CHZZK, 2026-09-06; fast-forward matches skipControl.js.
        // No page scripts or animation IDs are copied.
        const speaker =
            "M13.0632 13.9352H9.7C9.3134 13.9352 9 14.2486 9 14.6352V21.1928C9 21.5794 9.3134 21.8928 9.7 21.8928H13.0633L18.5407 25.3447C19.0069 25.6385 19.614 25.3035 19.614 24.7525V11.0755C19.614 10.5245 19.0069 10.1895 18.5407 10.4832L13.0632 13.9352Z";
        const paths = {
            fastForward: "M9 27V9l12.75 9L9 27Zm15-18h3v18h-3V9Z",
            play: "M13.5 11.04C13.5 10.21 14.49 9.71 15.22 10.18L26.02 17.14C26.2 17.26 26.34 17.42 26.41 17.59C26.52 17.84 26.53 18.11 26.44 18.35C26.36 18.55 26.22 18.73 26.02 18.86L15.22 25.82C14.49 26.29 13.5 25.79 13.5 24.96Z",
            pause: "M13.11 10.01h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1ZM22.01 10.01h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1Z",
            quiet:
                speaker +
                "M23.0862 13.9364C24.1983 14.9695 24.8596 16.4612 24.8596 18.0107C24.8596 19.5611 24.1978 21.0454 23.0858 22.0782C22.868 22.2861 22.5558 22.3645 22.2666 22.2997C21.9751 22.2345 21.7233 22.0262 21.6315 21.7295C21.5384 21.4288 21.6341 21.1134 21.8599 20.9055C22.6219 20.1982 23.1176 19.113 23.1176 18.0107C23.1176 16.9081 22.6216 15.816 21.8603 15.1091C21.6153 14.8848 21.5249 14.5369 21.6523 14.2211C21.7774 13.9112 22.0762 13.718 22.3964 13.6937C22.6475 13.6747 22.9018 13.7594 23.0862 13.9364Z",
            sound:
                speaker +
                "M25.7049 11.4235C27.2959 13.0511 28.4737 15.4943 28.4737 18.0108C28.4737 20.5278 27.2955 22.9637 25.7045 24.5911C25.512 24.7936 25.2257 24.8776 24.9542 24.8107C24.6816 24.7434 24.4666 24.5347 24.3907 24.2646C24.3149 23.9949 24.3895 23.7051 24.5862 23.5055C25.9114 22.1505 26.9162 20.0429 26.9162 18.0108C26.9162 15.9786 25.9113 13.8639 24.5866 12.5091C24.3735 12.2942 24.3039 11.9753 24.408 11.6912C24.5122 11.4064 24.7721 11.2077 25.0745 11.1824C25.3105 11.1628 25.5424 11.2516 25.7049 11.4235ZM23.0552 13.9692C24.1584 14.9938 24.8145 16.4737 24.8145 18.0108C24.8145 19.5486 24.1579 21.0211 23.0548 22.0455C22.8485 22.2426 22.5517 22.3175 22.2763 22.2558C21.9989 22.1938 21.761 21.996 21.6744 21.7162C21.5867 21.4329 21.6766 21.1353 21.8904 20.9386C22.6614 20.2229 23.1625 19.1258 23.1625 18.0108C23.1625 16.8954 22.6612 15.7913 21.8907 15.0761C21.6588 14.8638 21.5739 14.5355 21.694 14.238C21.8119 13.9456 22.0948 13.7617 22.3997 13.7386C22.6389 13.7205 22.8805 13.8013 23.0552 13.9692Z",
            muted:
                speaker +
                "M22.929 15.9741C22.612 15.6585 22.6107 15.1456 22.9263 14.8286C23.2419 14.5115 23.7548 14.5103 24.0718 14.8259L26.3136 17.0571L28.5554 14.8259C28.8725 14.5103 29.3853 14.5115 29.7009 14.8286C30.0165 15.1456 30.0153 15.6585 29.6982 15.9741L27.4618 18.2L29.6982 20.4259C30.0153 20.7414 30.0165 21.2543 29.7009 21.5714C29.3853 21.8884 28.8725 21.8896 28.5554 21.5741L26.3136 19.3428L24.0718 21.5741C23.7548 21.8896 23.2419 21.8884 22.9263 21.5714C22.6108 21.2543 22.612 20.7414 22.929 20.4259L25.1654 18.2L22.929 15.9741Z",
        };
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"),
            path = document.createElementNS(svg.namespaceURI, "path");
        svg.setAttribute("viewBox", "0 0 36 36");
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("focusable", "false");
        svg.setAttribute("fill", "currentColor");
        path.setAttribute("d", paths[kind]);
        path.setAttribute("stroke-linejoin", "round");
        path.setAttribute("fill-rule", "evenodd");
        path.setAttribute("stroke", "#000");
        path.setAttribute("stroke-opacity", "0.1");
        path.setAttribute("stroke-width", "2");
        path.style.paintOrder = "stroke";
        svg.append(path);
        node.replaceChildren(svg);
    }

    root.multiviewView = {
        text,
        el,
        button,
        delayButton,
        panelIcon,
        multiviewIcon,
        setControlIcon,
        action: (node) => controlActions.get(node),
    };
})();
