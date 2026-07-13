import { Component, type ReactNode } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";

interface Props {
  id: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  componentDidCatch(error: Error) {
    this.setState({ hasError: true, error });
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle>Widget {this.props.id} crashed</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground">
            <p>{this.state.error?.message}</p>
          </CardContent>
        </Card>
      );
    }
    return this.props.children;
  }
}
