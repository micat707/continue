import styled, { keyframes } from "styled-components";

const gradient = keyframes`
  0% {
    background-position: 0px 0;
  }
  100% {
    background-position: 100em 0;
  }
`;

export const GradientBorder = styled.div<{
  borderRadius?: string;
  borderColor?: string;
  loading: 0 | 1;
}>`
  border-radius: ${(props) => props.borderRadius || "0"};
  padding: 1px;
  background: ${(props) =>
    props.borderColor
      ? props.borderColor
      : `repeating-linear-gradient(
      101.79deg,
      #1BBE84 0%,
      #331BBE 16%,
      #BE1B55 33%,
      #A6BE1B 55%,
      #BE1B55 67%,
      #331BBE 85%,
      #1BBE84 99%
    )`};
  animation: ${(props) => (props.loading ? gradient : "")} 6s linear infinite;
  background-size: 200% 200%;
  width: 100%;
  /* CRITICAL for edge alignment: with the default content-box sizing,
     width:100% + padding:1px makes the frame 2px WIDER than its container,
     overflowing to the RIGHT — the input frame's right edge then hangs 2px
     past the streaming bar above it at every screen size. border-box makes
     the frame's outer box exactly fill the container content box. */
  box-sizing: border-box;
  display: flex;
  flex-direction: row;
  align-items: center;
  /* NO loading-conditional margin here: margin-top used to flip between 8px
     and 0 as the loading prop toggled, which shifted the streaming user
     bubble (and everything below it) by 8px every time a turn started,
     continued or ended — the "question content refreshes" flicker after
     confirming an edit. Spacing is owned by the parent rows (kiro-user-row /
     composer wrapper). */
`;
