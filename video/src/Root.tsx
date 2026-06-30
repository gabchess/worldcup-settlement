import React from "react";
import { Composition } from "remotion";
import { DemoVideo } from "./Composition";

// Total frames: 203.6s × 30fps = 6108
export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="demo"
      component={DemoVideo}
      durationInFrames={6108}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
