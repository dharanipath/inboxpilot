import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { type Location, MemoryRouter, useLocation, useRoutes } from "react-router-dom";

import { routes } from "@/App";
import { TooltipProvider } from "@/components/ui/primitives";
import { Toaster } from "@/components/ui/toast";

export function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
}

/**
 * Same route table as production, in a MemoryRouter. (The data router builds fetch Requests with
 * jsdom's AbortSignal, which Node's fetch rejects, so it can't navigate under jsdom.)
 */
export function renderApp(path: string) {
  const router = {
    state: { location: { pathname: path } as Pick<Location, "pathname" | "search"> },
  };
  function Routes() {
    router.state.location = useLocation();
    return useRoutes(routes);
  }
  const qc = testQueryClient();
  const utils = render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes />
        </MemoryRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...utils, router, qc };
}

export function renderWithProviders(ui: ReactElement) {
  const qc = testQueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}
