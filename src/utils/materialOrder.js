export function materialKey(block = {}) {
  return block.materialId || block.id || "";
}

/** 将素材按原始图文顺序插入，而非一律追加到正文末尾。 */
export function insertMaterialAtSourceOrder(
  existingBlocks,
  materialBlocks,
  candidates,
  createId,
) {
  const order = new Map(
    materialBlocks.map((block, index) => [materialKey(block), index]),
  );
  const blocks = [...existingBlocks];
  for (const candidate of candidates) {
    const candidateOrder = order.get(materialKey(candidate)) ?? Infinity;
    const insertAt = blocks.findIndex(
      (block) => (order.get(materialKey(block)) ?? Infinity) > candidateOrder,
    );
    const draftBlock = { ...candidate, id: createId() };
    if (insertAt === -1) blocks.push(draftBlock);
    else blocks.splice(insertAt, 0, draftBlock);
  }
  return blocks;
}
