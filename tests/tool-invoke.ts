export function familyTool(world: { tools(): Array<{ name: string; handler: (args: any, context: any) => unknown }> }, family: string) {
  const unified = world.tools().find(tool => tool.name === 'starpost_use');
  if (!unified) throw new Error('starpost tool is missing');
  return {
    name: `starpost_${family}`,
    handler: (args: Record<string, unknown>, context: unknown) => {
      const { action, ...payload } = args;
      return unified.handler({ family, action: typeof action === 'string' ? action : 'call', argsJson: JSON.stringify(payload) }, context);
    },
  };
}
