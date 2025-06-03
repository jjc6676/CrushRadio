import { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "./Tooltip";
import { SonnerToaster } from "./SonnerToaster";
import { YouTubeApiManagerProvider } from "../helpers/youTubeApiManager";

const queryClient = new QueryClient();

export const GlobalContextProviders = ({
  children,
}: {
  children: ReactNode;
}) => {
  return (
    <QueryClientProvider client={queryClient}>
      <YouTubeApiManagerProvider>
        <TooltipProvider>
          {children}
          <SonnerToaster />
        </TooltipProvider>
      </YouTubeApiManagerProvider>
    </QueryClientProvider>
  );
};
