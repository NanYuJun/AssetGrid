const imageCache = new Map()

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

const defaultDivider = () => ({ width: 2, color: '#dbe4db' })

export function getCanvasDivider(canvas) {
  const divider = canvas?.divider
  return {
    width: clamp(Number(divider?.width) || 0, 0, 50),
    color: /^#[0-9a-fA-F]{6}$/.test(divider?.color || '') ? divider.color : '#dbe4db',
  }
}

export function getCellBoxes(project, width, height) {
  const scale = width / project.canvas.width
  const gap = project.canvas.gap * scale
  const rows = project.rows
  const rowSpace = height - gap * (rows.length - 1)
  const totalRowWeight = rows.reduce((sum, row) => sum + row.weight, 0)
  let y = 0
  const boxes = []

  for (const row of rows) {
    const rowHeight = rowSpace * row.weight / totalRowWeight
    const cellSpace = width - gap * (row.cells.length - 1)
    const totalCellWeight = row.cells.reduce((sum, cell) => sum + cell.weight, 0)
    let x = 0
    for (const cell of row.cells) {
      const cellWidth = cellSpace * cell.weight / totalCellWeight
      boxes.push({ cell, row, x, y, width: cellWidth, height: rowHeight })
      x += cellWidth + gap
    }
    y += rowHeight + gap
  }

  return boxes
}

export function getDividerLines(project, width, height) {
  const boxes = getCellBoxes(project, width, height)
  const gap = project.canvas.gap * width / project.canvas.width
  const settings = getCanvasDivider(project.canvas)
  const thickness = Math.min(settings.width * width / project.canvas.width, gap)
  if (thickness <= 0) return []
  const lines = []
  for (let index = 0; index < project.rows.length - 1; index += 1) {
    const row = project.rows[index]
    const cell = boxes.find(box => box.row.id === row.id)
    if (!cell) continue
    lines.push({ x: 0, y: cell.y + cell.height + gap / 2 - thickness / 2, width, height: thickness })
  }
  for (const row of project.rows) {
    const rowBoxes = boxes.filter(box => box.row.id === row.id)
    for (let index = 0; index < rowBoxes.length - 1; index += 1) {
      const cell = rowBoxes[index]
      lines.push({ x: cell.x + cell.width + gap / 2 - thickness / 2, y: cell.y, width: thickness, height: cell.height })
    }
  }
  return lines
}

export function getImagePlacement(asset, cell, box) {
  const cover = Math.max(box.width / asset.width, box.height / asset.height)
  const zoom = cell.crop?.zoom ?? 1
  const width = asset.width * cover * zoom
  const height = asset.height * cover * zoom
  const travelX = Math.abs(width - box.width) / 2
  const travelY = Math.abs(height - box.height) / 2
  const offsetX = (cell.crop?.x ?? 0) * (cell.crop?.mode === 'free' ? box.width : travelX)
  const offsetY = (cell.crop?.y ?? 0) * (cell.crop?.mode === 'free' ? box.height : travelY)
  return {
    width,
    height,
    x: (box.width - width) / 2 + offsetX,
    y: (box.height - height) / 2 + offsetY,
    travelX,
    travelY,
  }
}

async function loadImage(asset) {
  if (!imageCache.has(asset.id)) {
    const promise = new Promise((resolve, reject) => {
      const url = URL.createObjectURL(asset.blob)
      const image = new Image()
      image.onload = () => {
        URL.revokeObjectURL(url)
        resolve(image)
      }
      image.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error(`无法读取图片：${asset.name}`))
      }
      image.src = url
    })
    imageCache.set(asset.id, promise)
  }
  return imageCache.get(asset.id)
}

export async function renderProject(project, resolveAsset, outputWidth = project.canvas.width) {
  const width = outputWidth
  const height = Math.round(outputWidth * project.canvas.height / project.canvas.width)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('浏览器无法创建画布')
  context.fillStyle = project.canvas.background
  context.fillRect(0, 0, width, height)

  for (const box of getCellBoxes(project, width, height)) {
    if (!box.cell.imageId) continue
    const asset = await resolveAsset(box.cell.imageId)
    if (!asset) throw new Error('作品引用的图片已丢失')
    const image = await loadImage(asset)
    const placement = getImagePlacement(asset, box.cell, box)
    context.save()
    context.beginPath()
    context.rect(box.x, box.y, box.width, box.height)
    context.clip()
    context.drawImage(image, box.x + placement.x, box.y + placement.y, placement.width, placement.height)
    context.restore()
  }
  const divider = getCanvasDivider(project.canvas)
  context.fillStyle = divider.color
  for (const line of getDividerLines(project, width, height)) {
    const radius = Math.min(line.width, line.height) / 2
    context.beginPath()
    if (typeof context.roundRect === 'function') context.roundRect(line.x, line.y, line.width, line.height, radius)
    else context.rect(line.x, line.y, line.width, line.height)
    context.fill()
  }
  return canvas
}

export function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片导出失败')), type, quality)
  })
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
