// Drawing inside the workbench mod (C:\code\cc-mods\workbench): it draws a
// frame with an empty Box keyed `slot-<pane id>` for each pane it shows, and
// this mod hooks the workbench pane's ui.render, takes that frame from
// next(e) and fills its own slot. The same file sits in each hosted mod.
/** The workbench's pane id. */
export const BENCH = 'workbench';
const isNode = (value) => typeof value === 'object' && value !== null && typeof value.type === 'string';
/** The columns the workbench gave pane `id`'s slot; undefined while it does not show it. */
export function slotOf(tree, id) {
    if (!isNode(tree))
        return undefined;
    if (tree.props?.key === `slot-${id}`)
        return { columns: typeof tree.props.width === 'number' ? tree.props.width : 40 };
    for (const child of tree.children ?? []) {
        const found = slotOf(child, id);
        if (found)
            return found;
    }
    return undefined;
}
/** The frame with pane `id`'s slot holding `body` in place of the placeholder. */
export function fillSlot(tree, id, body) {
    const fill = (node) => {
        if (!isNode(node))
            return node;
        if (node.props?.key === `slot-${id}`)
            return { ...node, children: [body] };
        return node.children ? { ...node, children: node.children.map(fill) } : node;
    };
    return fill(tree);
}
/** A pane event narrowed to a slot's width, for a draw function written for the pane. */
export function inSlot(e, columns) {
    return { ...e, props: { ...e.props, bodyColumns: columns }, ...(e.viewport ? { viewport: { ...e.viewport, columns } } : {}) };
}
