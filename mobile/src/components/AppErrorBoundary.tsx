/**
 * Root error boundary: a render error anywhere in the app shows a recovery
 * screen ("Try again") instead of a blank app, and is reported
 * (lib/crashReporter.ts).
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "@shared/theme";
import { reportCrash } from "@/lib/crashReporter";

interface State {
  error: Error | null;
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportCrash(error, "error-boundary", true, info.componentStack);
  }

  private retry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <View style={styles.screen} accessibilityRole="alert">
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.body}>
          Sorry about that — the problem has been reported. Your cart and orders are safe. Please try again.
        </Text>
        <Pressable onPress={this.retry} style={styles.button} accessibilityRole="button" accessibilityLabel="Try again">
          <Text style={styles.buttonText}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    backgroundColor: colors.background,
  },
  title: { fontSize: 20, fontWeight: "700", color: colors.textPrimary, textAlign: "center" },
  body: { marginTop: spacing.sm, fontSize: 15, color: colors.textSecondary, textAlign: "center" },
  button: {
    marginTop: spacing.xl,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
  },
  buttonText: { color: colors.surface, fontSize: 16, fontWeight: "700" },
});
