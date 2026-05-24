/**
 * TasksLayout — parent layout for /tasks/* routes (mt#1923).
 *
 * Renders a tab bar at the top that lets the operator toggle between
 * the List view (/tasks) and the Graph view (/tasks/graph).
 * The active tab is derived from the current URL path so the URL is
 * the single source of truth — browser back/forward works naturally.
 *
 * Uses React Router's <Outlet> to render the active child route, and
 * passes taskGraphData to child pages via outlet context so both views
 * share the same data without a separate fetch.
 */
import { useLocation, useNavigate, Outlet } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import type { WidgetData } from "../lib/widget-client";

interface TasksLayoutProps {
  taskGraphData: WidgetData | null;
}

export interface TasksOutletContext {
  taskGraphData: WidgetData | null;
}

type TaskView = "list" | "graph";

function activeView(pathname: string): TaskView {
  // /tasks/graph → graph; /tasks or /tasks/ → list
  return pathname === "/tasks/graph" ? "graph" : "list";
}

export function TasksLayout({ taskGraphData }: TasksLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const view = activeView(location.pathname);

  function handleTabChange(value: string) {
    if (value === "graph") {
      navigate("/tasks/graph");
    } else {
      navigate("/tasks");
    }
  }

  const outletContext: TasksOutletContext = { taskGraphData };

  return (
    <div className="flex flex-col w-full">
      {/* Tab bar */}
      <div className="px-4 pt-3 pb-0 border-b border-border/60 bg-background/80">
        <Tabs value={view} onValueChange={handleTabChange}>
          <TabsList className="h-8 gap-0.5 bg-transparent p-0 border-0">
            <TabsTrigger
              value="list"
              className="h-8 px-3 text-xs rounded-none border-b-2 border-transparent
                data-[state=active]:border-primary data-[state=active]:bg-transparent
                data-[state=active]:text-foreground data-[state=active]:shadow-none"
            >
              List
            </TabsTrigger>
            <TabsTrigger
              value="graph"
              className="h-8 px-3 text-xs rounded-none border-b-2 border-transparent
                data-[state=active]:border-primary data-[state=active]:bg-transparent
                data-[state=active]:text-foreground data-[state=active]:shadow-none"
            >
              Graph
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Active child route */}
      <Outlet context={outletContext} />
    </div>
  );
}
