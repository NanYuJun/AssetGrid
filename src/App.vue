<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  deleteAsset, deleteProject, deleteTemplate, getAsset, importPackage,
  listAssets, listProjects, listTemplates, putAsset, putProject, putTemplate,
} from './lib/db'
import { canvasToBlob, clamp, downloadBlob, getCanvasDivider, getCellBoxes, getDividerLines, getImagePlacement, renderProject } from './lib/canvas'

const uid = () => crypto.randomUUID()
const clone = value => JSON.parse(JSON.stringify(value))
const now = () => new Date().toISOString()
const freshCrop = () => ({ x: 0, y: 0, zoom: 1, mode: 'free' })
const makeRows = counts => counts.map(count => ({ id: uid(), weight: 1, cells: Array.from({ length: count }, () => ({ id: uid(), weight: 1, imageId: null, crop: freshCrop() })) }))

const presets = [
  { id: 'preset-2x3', name: '经典 2 × 3', detail: '6 格 · 纵横有序', counts: [3, 3], width: 3840, height: 2160 },
  { id: 'preset-3x3', name: '均衡 3 × 3', detail: '9 格 · 方正构图', counts: [3, 3, 3], width: 3840, height: 3840 },
  { id: 'preset-2-3', name: '上 2 下 3', detail: '5 格 · 层次分明', counts: [2, 3], width: 3840, height: 2160 },
]

const projects = ref([])
const templates = ref([])
const assets = ref([])
const assetUrls = ref({})
const activeProject = ref(null)
const draftTemplate = ref(null)
const mode = ref('project')
const selectedCellId = ref(null)
const selectedHistoryTemplate = ref('all')
const mobilePanel = ref(null)
const dialog = ref(null)
const assetPicker = ref(false)
const pickerCellId = ref(null)
const saveStatus = ref('loading')
const savingFile = ref(false)
const toast = ref(null)
const loading = ref(true)
const board = ref(null)
const leftSidebar = ref(null)
const historySection = ref(null)
const boardWidth = ref(0)
const uploadInput = ref(null)
const importInput = ref(null)
const exportFormat = ref('png')
const jpegQuality = ref(0.92)
const undoStack = ref([])
const redoStack = ref([])

let resizeObserver
let saveTimer
let saveQueue = Promise.resolve()
let saveSequence = 0
let toastTimer
let dragState = null
let sliderBefore = null
let marginDrag = null
let templateInitial = null
const activePointers = new Map()

const current = computed(() => mode.value === 'template' ? draftTemplate.value : activeProject.value)
const assetMap = computed(() => new Map(assets.value.map(asset => [asset.id, asset])))
const allTemplates = computed(() => [
  ...presets.map(preset => ({ ...preset, kind: 'preset' })),
  ...templates.value.map(template => ({ ...template, kind: 'custom' })),
])
const activeTemplateName = computed(() => activeProject.value?.templateName || '自定义模板')
const selectedCell = computed(() => current.value?.rows.flatMap(row => row.cells).find(cell => cell.id === selectedCellId.value) || null)
const selectedAsset = computed(() => selectedCell.value?.imageId ? assetMap.value.get(selectedCell.value.imageId) : null)
const selectedRow = computed(() => current.value?.rows.find(row => row.cells.some(cell => cell.id === selectedCellId.value)) || null)
const boardHeight = computed(() => current.value && boardWidth.value ? boardWidth.value * current.value.canvas.height / current.value.canvas.width : 0)
const boxes = computed(() => current.value && boardWidth.value ? getCellBoxes(current.value, boardWidth.value, boardHeight.value) : [])
const dividerLines = computed(() => current.value && boardWidth.value ? getDividerLines(current.value, boardWidth.value, boardHeight.value) : [])
const canvasDivider = computed(() => getCanvasDivider(current.value?.canvas))
const historyTemplateOptions = computed(() => {
  const names = new Map(projects.value.map(project => [project.templateId, project.templateName]))
  return [...names].map(([id, name]) => ({ id, name }))
})
const filteredProjects = computed(() => projects.value.filter(project => selectedHistoryTemplate.value === 'all' || project.templateId === selectedHistoryTemplate.value))
const canUndo = computed(() => undoStack.value.length > 0)
const canRedo = computed(() => redoStack.value.length > 0)

function notify(message, kind = 'info') {
  toast.value = { message, kind }
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = null }, 4200)
}

function freshProject(template, width, height, name) {
  return {
    id: uid(), name: name.trim() || '未命名作品', templateId: template.id,
    templateName: template.name, createdAt: now(), updatedAt: now(),
    canvas: { width, height, gap: template.canvas?.gap ?? 24, background: template.canvas?.background ?? '#ffffff', divider: getCanvasDivider(template.canvas) },
    rows: template.kind === 'preset' ? makeRows(template.counts) : clone(template.rows).map(row => ({ ...row, id: uid(), cells: row.cells.map(cell => ({ ...cell, id: uid(), imageId: null, crop: freshCrop() })) })),
  }
}

function sortProjects() {
  projects.value.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

async function resolveAsset(id) {
  return assetMap.value.get(id) || await getAsset(id)
}

async function persistProject(snapshot, sequence) {
  try {
    const thumbnail = await renderProject(snapshot, resolveAsset, 320)
    snapshot.preview = thumbnail.toDataURL('image/jpeg', 0.75)
    await putProject(snapshot)
    const index = projects.value.findIndex(item => item.id === snapshot.id)
    if (index < 0) projects.value.push(snapshot)
    else if (projects.value[index].updatedAt <= snapshot.updatedAt) projects.value[index] = snapshot
    sortProjects()
    if (activeProject.value?.id === snapshot.id && sequence === saveSequence) saveStatus.value = 'saved'
  } catch (error) {
    if (activeProject.value?.id === snapshot.id) saveStatus.value = 'error'
    notify(`自动保存失败：${error.message}。请先导出 JSON 备份。`, 'error')
    throw error
  }
}

function scheduleSave() {
  if (mode.value !== 'project' || !activeProject.value) return
  activeProject.value.updatedAt = now()
  saveStatus.value = 'saving'
  saveSequence += 1
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { void flushSave() }, 550)
}

async function flushSave() {
  clearTimeout(saveTimer)
  saveTimer = null
  if (saveStatus.value === 'saving' && activeProject.value) {
    const snapshot = clone(activeProject.value)
    const sequence = saveSequence
    saveQueue = saveQueue.catch(() => {}).then(() => persistProject(snapshot, sequence))
  }
  await saveQueue
}

function pushUndo(before) {
  undoStack.value.push(before)
  if (undoStack.value.length > 50) undoStack.value.shift()
  redoStack.value = []
}

function changeProject(action) {
  if (!activeProject.value || mode.value !== 'project') return
  const before = clone(activeProject.value)
  action()
  pushUndo(before)
  scheduleSave()
}

function undo() {
  if (!canUndo.value || !activeProject.value) return
  redoStack.value.push(clone(activeProject.value))
  activeProject.value = undoStack.value.pop()
  if (!selectedCell.value) selectedCellId.value = null
  scheduleSave()
}

function redo() {
  if (!canRedo.value || !activeProject.value) return
  undoStack.value.push(clone(activeProject.value))
  activeProject.value = redoStack.value.pop()
  if (!selectedCell.value) selectedCellId.value = null
  scheduleSave()
}

async function refreshAssets() {
  for (const url of Object.values(assetUrls.value)) URL.revokeObjectURL(url)
  assets.value = await listAssets()
  assetUrls.value = Object.fromEntries(assets.value.map(asset => [asset.id, URL.createObjectURL(asset.blob)]))
}

async function initialize() {
  try {
    const [storedProjects, storedTemplates] = await Promise.all([listProjects(), listTemplates()])
    projects.value = storedProjects
    templates.value = storedTemplates
    sortProjects()
    await refreshAssets()
    const lastId = localStorage.getItem('assetgrid-active-project')
    activeProject.value = clone(projects.value.find(item => item.id === lastId) || projects.value[0] || freshProject({ ...presets[0], kind: 'preset' }, 3840, 2160, '我的第一张宫格'))
    activeProject.value.canvas.divider = getCanvasDivider(activeProject.value.canvas)
    localStorage.setItem('assetgrid-active-project', activeProject.value.id)
    selectedCellId.value = activeProject.value.rows[0]?.cells[0]?.id || null
    saveStatus.value = projects.value.length ? 'saved' : 'saving'
    if (!projects.value.length) await flushSave()
  } catch (error) {
    saveStatus.value = 'error'
    notify(`无法打开本地作品库：${error.message}`, 'error')
  } finally {
    loading.value = false
  }
}

function openCreate(template) {
  if (!leaveTemplate()) return
  dialog.value = { type: 'create', template, width: template.width || template.canvas?.width || 3840, height: template.height || template.canvas?.height || 2160, name: '未命名作品' }
  mobilePanel.value = null
}

function setCreateShape(shape) {
  if (!dialog.value || dialog.value.type !== 'create') return
  const dimensions = { square: [3840, 3840], landscape: [3840, 2160], portrait: [2160, 3840] }
  ;[dialog.value.width, dialog.value.height] = dimensions[shape]
}

function validDimension(value) {
  return Number.isInteger(Number(value)) && Number(value) >= 128 && Number(value) <= 16384
}

function validGeometry(canvas, rows) {
  return canvas.gap * (rows.length - 1) < canvas.height && rows.every(row => canvas.gap * (row.cells.length - 1) < canvas.width)
}

async function createFromDialog() {
  const { template, width, height, name } = dialog.value
  if (!validDimension(width) || !validDimension(height)) return notify('画布宽高请输入 128–16384 之间的整数', 'error')
  if (!validGeometry({ width: Number(width), height: Number(height), gap: template.canvas?.gap ?? 24 }, template.kind === 'preset' ? makeRows(template.counts) : template.rows)) return notify('当前尺寸太小，无法容纳模板的格子间距', 'error')
  try {
    await flushSave()
    activeProject.value = freshProject(template, Number(width), Number(height), name)
    mode.value = 'project'
    undoStack.value = []
    redoStack.value = []
    selectedCellId.value = activeProject.value.rows[0].cells[0].id
    localStorage.setItem('assetgrid-active-project', activeProject.value.id)
    dialog.value = null
    scheduleSave()
    await flushSave()
    notify('新作品已创建')
  } catch { /* persistProject has already shown the save error */ }
}

async function openProject(item) {
  if (!leaveTemplate()) return
  try {
    await flushSave()
    activeProject.value = clone(item)
    mode.value = 'project'
    selectedCellId.value = item.rows[0]?.cells[0]?.id || null
    undoStack.value = []
    redoStack.value = []
    saveStatus.value = 'saved'
    localStorage.setItem('assetgrid-active-project', item.id)
    mobilePanel.value = null
  } catch { /* keep the current project visible when saving fails */ }
}

async function duplicateProject(item) {
  try {
    await flushSave()
    const copy = clone(item)
    copy.id = uid()
    copy.name = `${item.name} 副本`
    copy.createdAt = now()
    copy.updatedAt = now()
    delete copy.preview
    activeProject.value = copy
    mode.value = 'project'
    selectedCellId.value = copy.rows[0]?.cells[0]?.id || null
    undoStack.value = []
    redoStack.value = []
    localStorage.setItem('assetgrid-active-project', copy.id)
    scheduleSave()
    await flushSave()
    notify('已复制作品')
  } catch { /* persistProject has already shown the save error */ }
}

async function removeProject(item) {
  if (!window.confirm(`删除作品“${item.name}”？此操作无法撤销。`)) return
  try {
    if (activeProject.value?.id === item.id) {
      clearTimeout(saveTimer)
      saveTimer = null
      saveStatus.value = 'saved'
      await saveQueue.catch(() => {})
    }
    await deleteProject(item.id)
    projects.value = projects.value.filter(project => project.id !== item.id)
    if (activeProject.value?.id === item.id) {
      const next = projects.value[0]
      if (next) await openProject(next)
      else {
        activeProject.value = freshProject({ ...presets[0], kind: 'preset' }, 3840, 2160, '未命名作品')
        mode.value = 'project'
        selectedCellId.value = activeProject.value.rows[0].cells[0].id
        localStorage.setItem('assetgrid-active-project', activeProject.value.id)
        scheduleSave()
      }
    }
    notify('作品已删除')
  } catch (error) { notify(`删除失败：${error.message}`, 'error') }
}

function startDIY() {
  if (!leaveTemplate()) return
  draftTemplate.value = {
    id: uid(), name: '我的宫格模板', kind: 'custom',
    canvas: { width: 3840, height: 2160, gap: 24, background: '#ffffff', divider: getCanvasDivider() },
    rows: makeRows([2, 3]), createdAt: now(), updatedAt: now(),
  }
  templateInitial = JSON.stringify(draftTemplate.value)
  mode.value = 'template'
  selectedCellId.value = draftTemplate.value.rows[0].cells[0].id
  mobilePanel.value = null
  nextTick(updateBoardWidth)
}

function editTemplate(template) {
  if (!leaveTemplate()) return
  draftTemplate.value = clone(template)
  templateInitial = JSON.stringify(draftTemplate.value)
  mode.value = 'template'
  selectedCellId.value = draftTemplate.value.rows[0]?.cells[0]?.id || null
  mobilePanel.value = null
  nextTick(updateBoardWidth)
}

function leaveTemplate() {
  if (mode.value !== 'template') return true
  if (templateInitial !== JSON.stringify(draftTemplate.value) && !window.confirm('放弃未保存的模板修改？')) return false
  mode.value = 'project'
  draftTemplate.value = null
  templateInitial = null
  selectedCellId.value = activeProject.value?.rows[0]?.cells[0]?.id || null
  return true
}

function changeRowCount(row, difference) {
  if (!draftTemplate.value) return
  const index = draftTemplate.value.rows.findIndex(item => item.id === row.id)
  if (difference > 0 && draftTemplate.value.canvas.gap * row.cells.length >= draftTemplate.value.canvas.width) return notify('当前画布宽度无法容纳更多格子', 'error')
  if (difference > 0 && row.cells.length < 5) row.cells.push(makeRows([1])[0].cells[0])
  if (difference < 0 && row.cells.length > 1) row.cells.pop()
  else if (difference < 0 && row.cells.length === 1 && draftTemplate.value.rows.length > 1) draftTemplate.value.rows.splice(index, 1)
  if (!selectedCell.value) selectedCellId.value = draftTemplate.value.rows[0].cells[0].id
}

function addRow() {
  if (draftTemplate.value?.rows.length < 5) {
    if (draftTemplate.value.canvas.gap * draftTemplate.value.rows.length >= draftTemplate.value.canvas.height) return notify('当前画布高度无法容纳更多行', 'error')
    draftTemplate.value.rows.push(makeRows([1])[0])
  }
}

async function saveTemplate() {
  const template = draftTemplate.value
  if (!template?.name.trim()) return notify('请为模板输入名称', 'error')
  try {
    template.name = template.name.trim()
    template.updatedAt = now()
    await putTemplate(clone(template))
    const index = templates.value.findIndex(item => item.id === template.id)
    if (index < 0) templates.value.unshift(clone(template))
    else templates.value[index] = clone(template)
    templateInitial = null
    mode.value = 'project'
    openCreate({ ...template, kind: 'custom' })
    notify('模板已保存，可以开始创作')
  } catch (error) { notify(`模板保存失败：${error.message}`, 'error') }
}

function uniqueTemplateName(base) {
  const names = new Set(templates.value.map(template => template.name))
  if (!names.has(base)) return base
  let index = 2
  while (names.has(`${base} ${index}`)) index += 1
  return `${base} ${index}`
}

function saveProjectAsTemplate() {
  if (!activeProject.value || mode.value !== 'project') return
  dialog.value = { type: 'templateName', name: uniqueTemplateName(`${activeProject.value.name}模板`) }
}

async function confirmSaveProjectAsTemplate() {
  if (!activeProject.value || dialog.value?.type !== 'templateName') return
  const trimmed = dialog.value.name.trim()
  if (!trimmed) return notify('请为模板输入名称', 'error')
  if (templates.value.some(template => template.name === trimmed)) return notify('已有同名模板，请换一个名称', 'error')
  const source = activeProject.value
  const template = {
    id: uid(),
    name: trimmed,
    kind: 'custom',
    canvas: { ...source.canvas, divider: getCanvasDivider(source.canvas) },
    rows: source.rows.map(row => ({
      id: uid(), weight: row.weight,
      cells: row.cells.map(cell => ({ id: uid(), weight: cell.weight, imageId: null, crop: freshCrop() })),
    })),
    createdAt: now(),
    updatedAt: now(),
  }
  try {
    await putTemplate(clone(template))
    templates.value.unshift(clone(template))
    dialog.value = null
    notify(`已保存为模板“${template.name}”`)
  } catch (error) { notify(`模板保存失败：${error.message}`, 'error') }
}

async function removeTemplate(template) {
  if (!window.confirm(`删除模板“${template.name}”？已有作品不受影响。`)) return
  try {
    await deleteTemplate(template.id)
    templates.value = templates.value.filter(item => item.id !== template.id)
    if (draftTemplate.value?.id === template.id) {
      mode.value = 'project'
      draftTemplate.value = null
      templateInitial = null
      selectedCellId.value = activeProject.value?.rows[0]?.cells[0]?.id || null
    }
    notify('模板已删除')
  } catch (error) { notify(`删除模板失败：${error.message}`, 'error') }
}

function updateCanvasField(field, event) {
  const value = Number(event.target.value)
  if (field === 'gap' ? !Number.isInteger(value) || value < 0 || value > 200 : !validDimension(value)) {
    event.target.value = current.value.canvas[field]
    return notify(field === 'gap' ? '间距请输入 0–200 像素' : '宽高请输入 128–16384 像素', 'error')
  }
  if (!validGeometry({ ...current.value.canvas, [field]: value }, current.value.rows)) {
    event.target.value = current.value.canvas[field]
    return notify('当前尺寸或间距无法容纳所有格子', 'error')
  }
  if (mode.value === 'template') current.value.canvas[field] = value
  else changeProject(() => { activeProject.value.canvas[field] = value })
}

function updateBackground(event) {
  if (mode.value === 'template') current.value.canvas.background = event.target.value
  else changeProject(() => { activeProject.value.canvas.background = event.target.value })
}

function updateDivider(field, event) {
  const value = field === 'width' ? Number(event.target.value) : event.target.value
  if (field === 'width' && (!Number.isFinite(value) || value < 0 || value > 50)) {
    event.target.value = canvasDivider.value.width
    return notify('分割线宽度请输入 0–50 像素', 'error')
  }
  if (field === 'color' && !/^#[0-9a-fA-F]{6}$/.test(value)) return
  if (mode.value === 'template') current.value.canvas.divider = { ...canvasDivider.value, [field]: value }
  else changeProject(() => { activeProject.value.canvas.divider = { ...canvasDivider.value, [field]: value } })
}

function updateName(event) {
  const name = event.target.value.trim() || '未命名作品'
  if (mode.value === 'template') draftTemplate.value.name = name
  else { activeProject.value.name = name; scheduleSave() }
  event.target.value = name
}

function selectCell(cellId) { selectedCellId.value = cellId }

function showMobilePanel(panel) {
  mobilePanel.value = mobilePanel.value === panel ? null : panel
  if (mobilePanel.value === 'templates') nextTick(() => { leftSidebar.value.scrollTop = 0 })
  if (mobilePanel.value === 'history') nextTick(() => {
    const sidebar = leftSidebar.value
    const section = historySection.value
    sidebar.scrollTop += section.getBoundingClientRect().top - sidebar.getBoundingClientRect().top - 24
  })
}

function cellStyle(box) {
  return { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` }
}

function imageStyle(box) {
  const asset = assetMap.value.get(box.cell.imageId)
  if (!asset) return {}
  const placement = getImagePlacement(asset, box.cell, box)
  return { left: `${placement.x}px`, top: `${placement.y}px`, width: `${placement.width}px`, height: `${placement.height}px` }
}

function imageDistances(cell, box, asset) {
  if (!cell || !box || !asset) return { top: 0, right: 0, bottom: 0, left: 0 }
  const placement = getImagePlacement(asset, cell, box)
  return {
    left: Math.round(placement.x),
    right: Math.round(box.width - placement.x - placement.width),
    top: Math.round(placement.y),
    bottom: Math.round(box.height - placement.y - placement.height),
  }
}

function updateBoardWidth() { boardWidth.value = board.value?.clientWidth || 0 }

watch(board, (element, previous) => {
  if (previous && resizeObserver) resizeObserver.unobserve(previous)
  if (element && resizeObserver) { resizeObserver.observe(element); nextTick(updateBoardWidth) }
})

function beginResize(event, box, direction) {
  event.preventDefault()
  event.stopPropagation()
  const row = box.row
  const cellIndex = row.cells.indexOf(box.cell)
  const rowIndex = current.value.rows.indexOf(row)
  const siblings = direction === 'x' ? row.cells : current.value.rows
  const index = direction === 'x' ? cellIndex : rowIndex
  if (index >= siblings.length - 1) return
  dragState = {
    kind: 'resize', direction, startX: event.clientX, startY: event.clientY,
    siblings, index, firstWeight: siblings[index].weight, secondWeight: siblings[index + 1].weight,
    totalWeight: siblings.reduce((sum, item) => sum + item.weight, 0),
    available: direction === 'x' ? boardWidth.value - current.value.canvas.gap * boardWidth.value / current.value.canvas.width * (siblings.length - 1) : boardHeight.value - current.value.canvas.gap * boardWidth.value / current.value.canvas.width * (siblings.length - 1),
    before: mode.value === 'project' ? clone(activeProject.value) : null,
  }
  event.currentTarget.setPointerCapture(event.pointerId)
  event.currentTarget.addEventListener('pointermove', handleResizeMove)
  event.currentTarget.addEventListener('pointerup', finishResize, { once: true })
  event.currentTarget.addEventListener('pointercancel', finishResize, { once: true })
}

function handleResizeMove(event) {
  if (!dragState || dragState.kind !== 'resize') return
  const state = dragState
  const delta = state.direction === 'x' ? event.clientX - state.startX : event.clientY - state.startY
  const deltaWeight = delta / state.available * state.totalWeight
  const pairWeight = state.firstWeight + state.secondWeight
  const minWeight = Math.min(36 / state.available * state.totalWeight, pairWeight / 2 - 0.001)
  const first = clamp(state.firstWeight + deltaWeight, minWeight, pairWeight - minWeight)
  state.siblings[state.index].weight = first
  state.siblings[state.index + 1].weight = pairWeight - first
  if (mode.value === 'project') scheduleSave()
}

function finishResize(event) {
  event.currentTarget.removeEventListener('pointermove', handleResizeMove)
  if (dragState?.kind === 'resize' && dragState.before && JSON.stringify(dragState.before.rows) !== JSON.stringify(activeProject.value.rows)) pushUndo(dragState.before)
  dragState = null
}

function beginImagePan(event, box) {
  if (mode.value !== 'project' || !box.cell.imageId) return
  event.preventDefault()
  event.stopPropagation()
  selectCell(box.cell.id)
  event.currentTarget.setPointerCapture(event.pointerId)
  activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  if (!dragState || dragState.kind !== 'image') {
    const asset = assetMap.value.get(box.cell.imageId)
    if (!asset) return
    const placement = getImagePlacement(asset, box.cell, box)
    dragState = {
      kind: 'image', cellId: box.cell.id, before: clone(activeProject.value),
      startX: event.clientX, startY: event.clientY,
      panX: box.cell.crop.mode === 'free' ? box.cell.crop.x : box.cell.crop.x * placement.travelX / box.width,
      panY: box.cell.crop.mode === 'free' ? box.cell.crop.y : box.cell.crop.y * placement.travelY / box.height,
      box, mouseX: event.clientX, mouseY: event.clientY,
    }
  }
  if (activePointers.size === 2) {
    const [a, b] = [...activePointers.values()]
    dragState.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y)
    dragState.pinchZoom = box.cell.crop.zoom
  }
}

function moveImage(event) {
  if (!dragState || dragState.kind !== 'image' || !activePointers.has(event.pointerId)) return
  activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  const cell = selectedCell.value
  if (!cell || cell.id !== dragState.cellId) return
  if (cell.crop.mode !== 'free') {
    cell.crop.mode = 'free'
    cell.crop.x = dragState.panX
    cell.crop.y = dragState.panY
  }
  if (activePointers.size === 2 && dragState.pinchDistance) {
    const [a, b] = [...activePointers.values()]
    const distance = Math.hypot(a.x - b.x, a.y - b.y)
    cell.crop.zoom = clamp(dragState.pinchZoom * distance / dragState.pinchDistance, 0.2, 4)
  } else if (activePointers.size === 1) {
    cell.crop.x = dragState.panX + (event.clientX - dragState.startX) / dragState.box.width
    cell.crop.y = dragState.panY + (event.clientY - dragState.startY) / dragState.box.height
    dragState.mouseX = event.clientX
    dragState.mouseY = event.clientY
  }
  scheduleSave()
}

function finishImagePan(event) {
  activePointers.delete(event.pointerId)
  if (activePointers.size === 1 && dragState?.kind === 'image') {
    const [point] = [...activePointers.values()]
    dragState.startX = point.x
    dragState.startY = point.y
    dragState.panX = selectedCell.value?.crop.x ?? 0
    dragState.panY = selectedCell.value?.crop.y ?? 0
    dragState.pinchDistance = null
  }
  if (activePointers.size === 0 && dragState?.kind === 'image') {
    if (event.currentTarget?.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (JSON.stringify(dragState.before.rows) !== JSON.stringify(activeProject.value.rows)) pushUndo(dragState.before)
    dragState = null
  }
}

function beginZoom() { if (activeProject.value) sliderBefore = clone(activeProject.value) }
function inputZoom(event) {
  if (!selectedCell.value || mode.value !== 'project') return
  const value = Number(event.target.value)
  if (!Number.isFinite(value)) return (event.target.value = Math.round(selectedCell.value.crop.zoom * 100))
  if (!sliderBefore) sliderBefore = clone(activeProject.value)
  selectedCell.value.crop.zoom = clamp(value / 100, 0.2, 4)
  event.target.value = Math.round(selectedCell.value.crop.zoom * 100)
  scheduleSave()
}

function updateMargin(side, event) {
  if (!selectedCell.value || mode.value !== 'project') return
  const field = event.target
  const value = Number(field.value)
  const box = boxes.value.find(item => item.cell.id === selectedCell.value.id)
  const asset = selectedAsset.value
  if (!box || !asset) return
  const distances = imageDistances(selectedCell.value, box, asset)
  if (!Number.isFinite(value)) return (field.value = distances[side])
  event.target.value = clamp(value, -Math.round(box.width), Math.round(box.width))
  changeProject(() => setImageDistance(side, Number(event.target.value), box, asset))
}

function setImageDistance(side, distance, box, asset) {
  const cell = selectedCell.value
  if (!cell || !box || !asset) return
  const current = imageDistances(cell, box, asset)
  const delta = distance - current[side]
  cell.crop.mode = 'free'
  if (side === 'left') cell.crop.x = (cell.crop.x ?? 0) + delta / box.width
  else if (side === 'right') cell.crop.x = (cell.crop.x ?? 0) - delta / box.width
  else if (side === 'top') cell.crop.y = (cell.crop.y ?? 0) + delta / box.height
  else cell.crop.y = (cell.crop.y ?? 0) - delta / box.height
}

function imageMarginDragStyle(box) {
  return box.cell.imageId ? { inset: '0' } : {}
}

function finishZoom() {
  if (sliderBefore && JSON.stringify(sliderBefore.rows) !== JSON.stringify(activeProject.value.rows)) pushUndo(sliderBefore)
  sliderBefore = null
}

function resetCrop() {
  if (selectedCell.value?.imageId) changeProject(() => { selectedCell.value.crop = freshCrop() })
}

function removeCellImage() {
  if (selectedCell.value?.imageId) changeProject(() => { selectedCell.value.imageId = null; selectedCell.value.crop = freshCrop() })
}

function removeCell() {
  if (!selectedCell.value || mode.value !== 'project') return
  const row = selectedRow.value
  if (activeProject.value.rows.length === 1 && row.cells.length === 1) return notify('画布至少需要保留一个格子', 'error')
  changeProject(() => {
    row.cells = row.cells.filter(cell => cell.id !== selectedCellId.value)
    if (!row.cells.length) activeProject.value.rows = activeProject.value.rows.filter(item => item.id !== row.id)
    else row.cells.forEach(cell => { cell.weight = 1 })
    selectedCellId.value = activeProject.value.rows[0].cells[0].id
  })
  notify('格子已删除，同排已重新均分')
}

function triggerUpload(cellId = null) {
  pickerCellId.value = cellId
  uploadInput.value?.click()
}

async function measureImage(blob) {
  const bitmap = await createImageBitmap(blob)
  const size = { width: bitmap.width, height: bitmap.height }
  bitmap.close()
  return size
}

async function handleUpload(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return notify('请选择 JPG、PNG 或 WebP 静态图片', 'error')
  try {
    const size = await measureImage(file)
    const asset = { id: uid(), name: file.name, type: file.type, blob: file, ...size, createdAt: now() }
    await putAsset(asset)
    assets.value.unshift(asset)
    assetUrls.value[asset.id] = URL.createObjectURL(file)
    if (pickerCellId.value) {
      const cell = activeProject.value?.rows.flatMap(row => row.cells).find(item => item.id === pickerCellId.value)
      if (cell) changeProject(() => attachImage(cell, asset.id))
      assetPicker.value = false
    }
    notify('图片已加入素材库')
  } catch (error) { notify(`图片上传失败：${error.message}`, 'error') }
}

function openAssetPicker(cellId) {
  pickerCellId.value = cellId
  assetPicker.value = true
}

function attachImage(cell, imageId) {
  const hasPlacedImage = Boolean(cell.imageId && cell.crop)
  cell.imageId = imageId
  if (!hasPlacedImage) cell.crop = freshCrop()
}

function assignAsset(asset) {
  const cell = activeProject.value?.rows.flatMap(row => row.cells).find(item => item.id === pickerCellId.value)
  if (!cell) return
  changeProject(() => attachImage(cell, asset.id))
  assetPicker.value = false
  selectedCellId.value = cell.id
}

async function removeAsset(asset) {
  const used = projects.value.some(project => project.id !== activeProject.value?.id && project.rows.some(row => row.cells.some(cell => cell.imageId === asset.id))) || activeProject.value?.rows.some(row => row.cells.some(cell => cell.imageId === asset.id))
  if (used) return notify('这张图片仍被作品使用，无法删除', 'error')
  if (!window.confirm(`从素材库删除“${asset.name}”？`)) return
  try {
    await deleteAsset(asset.id)
    URL.revokeObjectURL(assetUrls.value[asset.id])
    const urls = { ...assetUrls.value }
    delete urls[asset.id]
    assetUrls.value = urls
    assets.value = assets.value.filter(item => item.id !== asset.id)
    notify('图片已从素材库删除')
  } catch (error) { notify(`删除图片失败：${error.message}`, 'error') }
}

function safeFilename(name) { return name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'AssetGrid' }

async function exportImage() {
  if (!activeProject.value) return
  savingFile.value = true
  try {
    const canvas = await renderProject(activeProject.value, resolveAsset)
    const type = exportFormat.value === 'jpg' ? 'image/jpeg' : 'image/png'
    const blob = await canvasToBlob(canvas, type, jpegQuality.value)
    downloadBlob(blob, `${safeFilename(activeProject.value.name)}.${exportFormat.value}`)
    dialog.value = null
    notify('图片已导出')
  } catch (error) { notify(`导出失败：${error.message}`, 'error') }
  finally { savingFile.value = false }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

async function exportJson() {
  if (!activeProject.value) return
  savingFile.value = true
  try {
    const project = clone(activeProject.value)
    delete project.preview
    const ids = [...new Set(project.rows.flatMap(row => row.cells.map(cell => cell.imageId).filter(Boolean)))]
    const exportedAssets = []
    for (const id of ids) {
      const asset = await resolveAsset(id)
      if (!asset) throw new Error('作品引用的图片已丢失')
      exportedAssets.push({ id: asset.id, name: asset.name, type: asset.type, width: asset.width, height: asset.height, data: await blobToDataUrl(asset.blob) })
    }
    const blob = new Blob([JSON.stringify({ format: 'assetgrid', version: 1, project, assets: exportedAssets })], { type: 'application/json' })
    downloadBlob(blob, `${safeFilename(project.name)}.assetgrid.json`)
    notify('JSON 备份已导出')
  } catch (error) { notify(`备份失败：${error.message}`, 'error') }
  finally { savingFile.value = false }
}

function assertImport(data) {
  if (data?.format !== 'assetgrid' || data.version !== 1 || !data.project || !Array.isArray(data.assets)) throw new Error('不是受支持的 AssetGrid JSON 文件')
  const project = data.project
  if (typeof project.name !== 'string' || !validDimension(project.canvas?.width) || !validDimension(project.canvas?.height) || !Number.isInteger(project.canvas.gap) || project.canvas.gap < 0 || project.canvas.gap > 200 || (project.canvas.divider !== undefined && (!Number.isFinite(project.canvas.divider.width) || project.canvas.divider.width < 0 || project.canvas.divider.width > 50 || !/^#[0-9a-fA-F]{6}$/.test(project.canvas.divider.color))) || !/^#[0-9a-fA-F]{6}$/.test(project.canvas.background)) throw new Error('画布数据无效')
  if (!Array.isArray(project.rows) || project.rows.length < 1 || project.rows.length > 5) throw new Error('宫格行数无效')
  const imageIds = new Set()
  for (const row of project.rows) {
    if (!Number.isFinite(row.weight) || row.weight <= 0 || !Array.isArray(row.cells) || row.cells.length < 1 || row.cells.length > 5) throw new Error('宫格布局无效')
    for (const cell of row.cells) {
      if (!Number.isFinite(cell.weight) || cell.weight <= 0 || !cell.crop || !Number.isFinite(cell.crop.x) || !Number.isFinite(cell.crop.y) || !Number.isFinite(cell.crop.zoom) || cell.crop.zoom < 0.2 || cell.crop.zoom > 4 || (cell.crop.mode !== 'free' && (cell.crop.mode !== undefined || Math.abs(cell.crop.x) > 1 || Math.abs(cell.crop.y) > 1))) throw new Error('格子裁切数据无效')
      delete cell.crop.margin
      if (cell.imageId !== null && typeof cell.imageId !== 'string') throw new Error('格子图片引用无效')
      if (cell.imageId) imageIds.add(cell.imageId)
    }
  }
  if (!validGeometry(project.canvas, project.rows)) throw new Error('画布尺寸无法容纳宫格布局')
  const assetIds = new Set()
  for (const asset of data.assets) {
    if (typeof asset.id !== 'string' || assetIds.has(asset.id) || typeof asset.name !== 'string' || !['image/jpeg', 'image/png', 'image/webp'].includes(asset.type) || typeof asset.data !== 'string' || !asset.data.startsWith(`data:${asset.type};base64,`)) throw new Error('图片素材数据无效')
    assetIds.add(asset.id)
  }
  if ([...imageIds].some(id => !assetIds.has(id))) throw new Error('JSON 缺少作品使用的图片')
}

async function handleImport(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  try {
    await flushSave()
    const data = JSON.parse(await file.text())
    assertImport(data)
    const remap = new Map()
    const importedAssets = []
    for (const item of data.assets) {
      const response = await fetch(item.data)
      const blob = await response.blob()
      const size = await measureImage(blob)
      if (size.width !== item.width || size.height !== item.height) throw new Error(`图片尺寸不匹配：${item.name}`)
      const id = uid()
      remap.set(item.id, id)
      importedAssets.push({ id, name: item.name, type: item.type, blob, ...size, createdAt: now() })
    }
    const project = clone(data.project)
    project.canvas.divider = getCanvasDivider(project.canvas)
    project.id = uid()
    project.createdAt = now()
    project.updatedAt = now()
    project.rows = project.rows.map(row => ({ ...row, id: uid(), cells: row.cells.map(cell => ({ ...cell, id: uid(), imageId: cell.imageId ? remap.get(cell.imageId) : null })) }))
    delete project.preview
    const importedMap = new Map(importedAssets.map(asset => [asset.id, asset]))
    const thumbnail = await renderProject(project, id => importedMap.get(id), 320)
    project.preview = thumbnail.toDataURL('image/jpeg', 0.75)
    await importPackage(project, importedAssets)
    await refreshAssets()
    projects.value.unshift(project)
    sortProjects()
    activeProject.value = clone(project)
    mode.value = 'project'
    selectedCellId.value = project.rows[0].cells[0].id
    undoStack.value = []
    redoStack.value = []
    saveStatus.value = 'saved'
    localStorage.setItem('assetgrid-active-project', project.id)
    notify('JSON 已导入为新作品')
    mobilePanel.value = null
  } catch (error) { notify(`导入失败：${error.message}`, 'error') }
}

function keyboardShortcuts(event) {
  const target = event.target
  if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    if (event.shiftKey) redo()
    else undo()
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo() }
}

onMounted(() => {
  resizeObserver = new ResizeObserver(updateBoardWidth)
  if (board.value) resizeObserver.observe(board.value)
  window.addEventListener('keydown', keyboardShortcuts)
  void initialize()
})

onBeforeUnmount(() => {
  clearTimeout(saveTimer)
  clearTimeout(toastTimer)
  resizeObserver?.disconnect()
  window.removeEventListener('keydown', keyboardShortcuts)
  for (const url of Object.values(assetUrls.value)) URL.revokeObjectURL(url)
})
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand" aria-label="AssetGrid">
        <span class="brand-mark"><i></i><i></i><i></i><i></i></span>
        <span class="brand-name">Asset<span>Grid</span></span>
        <span class="brand-divider"></span>
        <span class="brand-subtitle">图片宫格工作台</span>
      </div>
      <div class="topbar-actions">
        <span v-if="mode === 'project'" class="save-indicator" :class="saveStatus"><span class="status-dot"></span>{{ saveStatus === 'saved' ? '已自动保存' : saveStatus === 'saving' ? '保存中…' : saveStatus === 'error' ? '保存失败' : '读取中…' }}</span>
        <button class="icon-text quiet desktop-only" :disabled="!canUndo || mode !== 'project'" title="撤销" @click="undo"><span>↶</span> 撤销</button>
        <button class="icon-text quiet desktop-only" :disabled="!canRedo || mode !== 'project'" title="重做" @click="redo"><span>↷</span> 重做</button>
        <button v-if="mode === 'project'" class="button button-outline json-action" @click="importInput?.click()">↑ 导入 JSON</button>
        <button v-if="mode === 'project'" class="button button-outline json-action" :disabled="savingFile || !activeProject" @click="exportJson">↓ 导出 JSON</button>
        <template v-else><button class="icon-text quiet" @click="leaveTemplate">返回作品</button><button class="button button-dark" @click="saveTemplate">保存模板 <span class="button-arrow">↗</span></button></template>
        <a class="github-link" href="https://github.com/NanYuJun/AssetGrid" target="_blank" rel="noopener noreferrer" aria-label="在 GitHub 查看 AssetGrid 项目" title="GitHub · AssetGrid">
          <svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"></path></svg>
        </a>
      </div>
    </header>

    <div class="workspace">
      <aside ref="leftSidebar" class="sidebar sidebar-left" :class="{ 'mobile-open': mobilePanel === 'templates' || mobilePanel === 'history' }">
        <div class="sidebar-pane sidebar-template-pane">
        <div class="sidebar-header">
          <div><div class="eyebrow">LAYOUT LIBRARY</div><h2>模板版式</h2></div>
          <button class="mobile-close" aria-label="关闭模板" @click="mobilePanel = null">×</button>
        </div>
        <p class="sidebar-intro">从一种布局开始，让每张图片都找到自己的位置。</p>
        <div class="sidebar-scroll-list template-scroll-region">
        <div class="sidebar-section-label"><span>精选模板</span><span>03</span></div>
        <div class="template-list">
          <button v-for="preset in presets" :key="preset.id" class="template-card" :class="{ active: activeProject?.templateId === preset.id && mode === 'project' }" @click="openCreate({ ...preset, kind: 'preset' })">
            <span class="template-preview" :class="`preview-${preset.id}`">
              <span v-for="(count, rowIndex) in preset.counts" :key="rowIndex" class="preview-row"><i v-for="n in count" :key="n"></i></span>
            </span>
            <span class="template-copy"><strong>{{ preset.name }}</strong><small>{{ preset.detail }}</small></span>
            <span class="template-arrow">↗</span>
          </button>
        </div>
        <div class="sidebar-section-label custom-heading"><span>我的模板</span><span>{{ String(templates.length).padStart(2, '0') }}</span></div>
        <div class="template-list custom-list">
          <div v-for="template in templates" :key="template.id" class="custom-template">
            <button class="custom-template-main" @click="openCreate({ ...template, kind: 'custom' })">
              <span class="mini-grid"><span v-for="row in template.rows" :key="row.id"><i v-for="cell in row.cells" :key="cell.id"></i></span></span>
              <span><strong>{{ template.name }}</strong><small>{{ template.rows.length }} 行 · {{ template.rows.reduce((sum, row) => sum + row.cells.length, 0) }} 格</small></span>
            </button>
            <button class="more-button" :aria-label="`编辑${template.name}`" title="编辑模板" @click="editTemplate(template)">✎</button>
            <button class="more-button danger-hover" :aria-label="`删除${template.name}`" title="删除模板" @click="removeTemplate(template)">×</button>
          </div>
          <p v-if="!templates.length" class="empty-small">你创建的版式会出现在这里。</p>
        </div>
        </div>
        <button class="add-template" @click="startDIY"><span class="add-square">＋</span><span><strong>DIY 新增模板</strong><small>最多 5 行 × 每行 5 格</small></span><span class="template-arrow">↗</span></button>
        </div>

        <section ref="historySection" class="left-history-section sidebar-pane">
        <div class="sidebar-header"><div><div class="eyebrow">YOUR ARCHIVE</div><h2>创作历史</h2></div><button class="mobile-close" aria-label="关闭历史" @click="mobilePanel = null">×</button></div>
        <p class="sidebar-intro">所有灵感都已为你妥善保存，随时回来继续创作。</p>
        <div class="history-toolbar"><span>{{ projects.length }} 件作品</span><select v-model="selectedHistoryTemplate" aria-label="按模板筛选历史"><option value="all">全部模板</option><option v-for="option in historyTemplateOptions" :key="option.id" :value="option.id">{{ option.name }}</option></select></div>
        <div class="history-list sidebar-scroll-list"><div v-for="item in filteredProjects" :key="item.id" class="history-card" :class="{ active: activeProject?.id === item.id && mode === 'project' }"><button class="history-open" @click="openProject(item)"><span class="history-preview"><img v-if="item.preview" :src="item.preview" alt="" /><span v-else class="history-preview-empty">▦</span></span><span class="history-detail"><strong>{{ item.name }}</strong><small>{{ item.templateName }}</small><em>{{ new Date(item.updatedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) }} · {{ item.canvas.width }} × {{ item.canvas.height }}</em></span></button><div class="history-actions"><button :aria-label="`复制${item.name}`" title="复制作品" @click="duplicateProject(item)">⧉</button><button class="danger-hover" :aria-label="`删除${item.name}`" title="删除作品" @click="removeProject(item)">×</button></div></div><p v-if="!filteredProjects.length" class="empty-small">这里还没有符合条件的作品。</p></div>
        </section>
      </aside>

      <main class="main-area">
        <div v-if="loading" class="loading-screen">正在打开你的工作台…</div>
        <template v-else-if="current">
          <div class="editor-panel">
            <div class="panel-topline"><span class="panel-label">{{ mode === 'template' ? '模板设置' : '当前作品' }}</span><span v-if="mode === 'template'" class="panel-number">LAYOUT</span><div v-else class="panel-actions"><button class="text-link panel-template" @click="saveProjectAsTemplate">存为模板</button><button class="button button-dark panel-export" @click="dialog = { type: 'export' }">↓ 保存图片</button></div></div>
            <div class="project-line"><input class="project-name" :value="current.name" :aria-label="mode === 'template' ? '模板名称' : '作品名称'" maxlength="60" @change="updateName" /><span class="name-edit-icon">✎</span><span class="project-meta">{{ current.rows.reduce((sum, row) => sum + row.cells.length, 0) }} 格 · {{ current.canvas.width }} × {{ current.canvas.height }} px</span></div>
            <div class="control-divider"></div>
            <div class="controls-row">
              <label class="control-field"><span>画布宽度 <em>PX</em></span><input type="number" min="128" max="16384" :value="current.canvas.width" @change="updateCanvasField('width', $event)" /></label>
              <span class="dimension-cross">×</span>
              <label class="control-field"><span>画布高度 <em>PX</em></span><input type="number" min="128" max="16384" :value="current.canvas.height" @change="updateCanvasField('height', $event)" /></label>
              <div class="control-divider-vertical"></div>
              <label class="control-field gap-field"><span>格子间距 <em>PX</em></span><input type="number" min="0" max="200" :value="current.canvas.gap" @change="updateCanvasField('gap', $event)" /></label>
              <label class="control-field gap-field"><span>分割线宽度 <em>PX</em></span><input type="number" min="0" max="50" :value="canvasDivider.width" @change="updateDivider('width', $event)" /></label>
              <label class="control-field color-field"><span>分割线颜色</span><span class="color-input-wrap"><input type="color" :value="canvasDivider.color" aria-label="分割线颜色" @input="updateDivider('color', $event)" /><span>{{ canvasDivider.color.toUpperCase() }}</span></span></label>
              <div class="control-divider-vertical"></div>
              <label class="control-field color-field"><span>背景颜色</span><span class="color-input-wrap"><input type="color" :value="current.canvas.background" @input="updateBackground" /><span>{{ current.canvas.background.toUpperCase() }}</span></span></label>
            </div>
            <div v-if="mode === 'template'" class="diy-controls"><div class="diy-head"><strong>每行格数</strong><span>点击 + / − 调整，拖动画布分隔线微调比例</span></div><div class="diy-rows"><div v-for="(row, index) in draftTemplate.rows" :key="row.id" class="diy-row"><span>第 {{ index + 1 }} 行</span><button :disabled="draftTemplate.rows.length === 1 && row.cells.length === 1" @click="changeRowCount(row, -1)">−</button><strong>{{ row.cells.length }}</strong><button :disabled="row.cells.length >= 5" @click="changeRowCount(row, 1)">＋</button></div><button class="add-row" :disabled="draftTemplate.rows.length >= 5" @click="addRow">＋ 添加一行</button></div></div>
          </div>

          <div class="canvas-section">
            <div class="canvas-titleline"><div><span class="section-kicker">LIVE CANVAS</span><h2>画布预览 <small>· {{ current.canvas.width }} × {{ current.canvas.height }}</small></h2></div><div class="canvas-actions"><button v-if="mode === 'project'" class="subtle-action" :disabled="!canUndo" @click="undo">↶ <span>撤销</span></button><button v-if="mode === 'project'" class="subtle-action" :disabled="!canRedo" @click="redo">↷ <span>重做</span></button><span class="zoom-label">100% 适配</span></div></div>
            <div class="canvas-stage">
              <div class="stage-ornament stage-ornament-a"></div><div class="stage-ornament stage-ornament-b"></div>
              <div ref="board" class="canvas-board" :style="{ aspectRatio: `${current.canvas.width} / ${current.canvas.height}`, background: current.canvas.background }">
                <div v-for="(line, lineIndex) in dividerLines" :key="`divider-${lineIndex}`" class="canvas-divider" :style="{ left: `${line.x}px`, top: `${line.y}px`, width: `${line.width}px`, height: `${line.height}px`, background: canvasDivider.color }"></div>
                <div v-for="(box, index) in boxes" :key="box.cell.id" class="grid-cell" :class="{ selected: selectedCellId === box.cell.id, 'has-image': !!box.cell.imageId }" :style="cellStyle(box)" @click="selectCell(box.cell.id)">
                  <template v-if="box.cell.imageId && assetMap.has(box.cell.imageId)"><div class="cell-image-viewport" :style="imageMarginDragStyle(box)"><img class="cell-image" :src="assetUrls[box.cell.imageId]" :style="imageStyle(box)" draggable="false" alt="" @pointerdown="beginImagePan($event, box)" @pointermove="moveImage" @pointerup="finishImagePan" @pointercancel="finishImagePan" /></div><div class="cell-photo-overlay" :style="imageMarginDragStyle(box)" @pointerdown="beginImagePan($event, box)" @pointermove="moveImage" @pointerup="finishImagePan" @pointercancel="finishImagePan"></div></template>
                  <template v-else><div class="empty-cell-inner"><span class="empty-cell-plus">＋</span><span>{{ mode === 'template' ? '格子 ' + String(index + 1).padStart(2, '0') : '添加图片' }}</span></div><button v-if="mode === 'project'" class="cell-upload-hit" :aria-label="`为第${index + 1}格添加图片`" @click.stop="selectCell(box.cell.id); openAssetPicker(box.cell.id)"></button></template>
                  <span class="cell-index">{{ String(index + 1).padStart(2, '0') }}</span>
                  <button v-if="box.row.cells.indexOf(box.cell) < box.row.cells.length - 1" class="resize-handle resize-x" :aria-label="`调整第${index + 1}格宽度`" @pointerdown="beginResize($event, box, 'x')"><span></span></button>
                </div>
                <button v-for="(row, rowIndex) in current.rows.slice(0, -1)" :key="row.id" class="resize-handle resize-y" :style="{ top: `${boxes.filter(box => box.row.id === row.id)[0]?.y + boxes.filter(box => box.row.id === row.id)[0]?.height}px` }" :aria-label="`调整第${rowIndex + 1}行高度`" @pointerdown="beginResize($event, boxes.find(box => box.row.id === row.id), 'y')"><span></span></button>
              </div>
              <span class="canvas-corner corner-tl"></span><span class="canvas-corner corner-br"></span>
            </div>
            <div class="canvas-caption"><span><i class="caption-dot"></i>{{ mode === 'template' ? '拖动分隔线来设计布局比例' : '点击格子，上传图片并自由调整裁切' }}</span><span>{{ current.rows.length }} 行 / {{ current.rows.reduce((sum, row) => sum + row.cells.length, 0) }} 格</span></div>
          </div>

        </template>
      </main>

      <aside class="sidebar sidebar-right inspector-sidebar" :class="{ 'mobile-open': mobilePanel === 'inspector' }">
          <button class="mobile-close inspector-close" aria-label="关闭格子编辑" @click="mobilePanel = null">×</button>
          <div v-if="mode === 'project'" class="cell-inspector"><div class="inspector-heading"><div><span class="section-kicker">CELL EDITOR</span><h2>格子编辑 <small v-if="selectedCell">· 已选中第 {{ boxes.findIndex(box => box.cell.id === selectedCellId) + 1 }} 格</small></h2></div><button class="text-link danger" :disabled="!selectedCell" @click="removeCell">删除格子</button></div><div v-if="selectedCell" class="inspector-body"><div class="selected-thumb"><img v-if="selectedAsset" :src="assetUrls[selectedAsset.id]" alt="当前格子图片" /><span v-else>＋</span></div><div class="selected-info"><strong>{{ selectedAsset?.name || '这个格子还是空的' }}</strong><small>{{ selectedAsset ? `${selectedAsset.width} × ${selectedAsset.height} px` : '上传图片，或从素材库中挑选' }}</small><div class="selected-actions"><button class="button button-outline" @click="triggerUpload(selectedCell.id)">↑ 上传图片</button><button class="button button-outline" @click="openAssetPicker(selectedCell.id)">▦ 素材库</button><button v-if="selectedAsset" class="text-link" @click="removeCellImage">移除图片</button></div></div><div v-if="selectedAsset" class="zoom-control">
            <div class="edit-controls-head"><strong>图片裁切</strong><button class="text-link" @click="resetCrop">重置</button></div>
            <label class="zoom-number"><span>缩放</span><input type="number" min="20" max="400" step="1" :value="Math.round(selectedCell.crop.zoom * 100)" aria-label="图片缩放百分比" @pointerdown="beginZoom" @change="inputZoom; finishZoom" @keydown.enter="inputZoom; finishZoom" /><em>%</em></label>
            <input class="zoom-range" aria-label="图片缩放滑杆" type="range" min="20" max="400" step="1" :value="Math.round(selectedCell.crop.zoom * 100)" @pointerdown="beginZoom" @input="inputZoom" @change="finishZoom" />
            <div class="margin-heading"><strong>图片位置边距</strong><span>PX</span></div>
            <div class="margin-fields"><label v-for="side in [['top','上'],['right','右'],['bottom','下'],['left','左']]" :key="side[0]"><span>{{ side[1] }}</span><input type="number" step="1" :value="imageDistances(selectedCell, boxes.find(box => box.cell.id === selectedCell.id), selectedAsset)[side[0]]" :aria-label="side[1] + '边距'" @change="updateMargin(side[0], $event)" /></label></div>
            <p class="crop-hint">直接拖拽图片自由移动；格子边线始终显示在最上层。</p>
          </div></div><div v-else class="inspector-empty">选择一个格子，即可上传、替换或调整图片。</div></div>
          <div v-else class="template-bottom-note"><span>✳</span><p>模板只保存版式，不包含图片。保存后即可从左侧重复使用。</p><button class="button button-dark" @click="saveTemplate">保存这个模板 ↗</button></div>

      </aside>
    </div>

    <nav class="mobile-nav" aria-label="手机导航"><button :class="{ active: mobilePanel === 'templates' }" @click="showMobilePanel('templates')"><span>▦</span> 模板</button><button :class="{ active: mobilePanel === 'history' }" @click="showMobilePanel('history')"><span>◷</span> 历史</button><button :class="{ active: mobilePanel === null }" @click="mobilePanel = null"><span>▣</span> 画布</button><button :class="{ active: mobilePanel === 'inspector' }" @click="showMobilePanel('inspector')"><span>✎</span> 格子</button></nav>
    <div v-if="mobilePanel" class="mobile-scrim" @click="mobilePanel = null"></div>

    <input ref="uploadInput" class="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" @change="handleUpload" />
    <input ref="importInput" class="visually-hidden" type="file" accept="application/json,.json" @change="handleImport" />

    <div v-if="dialog" class="modal-backdrop" @click.self="dialog = null"><div class="modal-card"><button class="modal-close" aria-label="关闭" @click="dialog = null">×</button><template v-if="dialog.type === 'create'"><div class="modal-kicker">NEW CANVAS</div><h2>新建宫格作品</h2><p>选择画布尺寸，从「{{ dialog.template.name }}」开始。</p><label class="modal-field">作品名称<input v-model="dialog.name" maxlength="60" placeholder="未命名作品" /></label><div class="modal-field"><span>快速选择尺寸</span><div class="shape-options"><button :class="{ active: dialog.width === dialog.height }" @click="setCreateShape('square')"><span class="shape-icon shape-square"></span>正方形</button><button :class="{ active: dialog.width > dialog.height }" @click="setCreateShape('landscape')"><span class="shape-icon shape-landscape"></span>横向</button><button :class="{ active: dialog.width < dialog.height }" @click="setCreateShape('portrait')"><span class="shape-icon shape-portrait"></span>纵向</button></div></div><div class="modal-dimensions"><label class="modal-field">宽度 <em>PX</em><input v-model.number="dialog.width" type="number" min="128" max="16384" /></label><span>×</span><label class="modal-field">高度 <em>PX</em><input v-model.number="dialog.height" type="number" min="128" max="16384" /></label></div><button class="button button-dark modal-primary" @click="createFromDialog">创建作品 ↗</button></template><template v-else-if="dialog.type === 'templateName'"><div class="modal-kicker">SAVE AS TEMPLATE</div><h2>存为模板</h2><p>保存当前作品的版式与画布设置，图片不会包含在模板中。</p><label class="modal-field">模板名称<input v-model="dialog.name" maxlength="60" placeholder="模板名称" /></label><button class="button button-dark modal-primary" @click="confirmSaveProjectAsTemplate">保存模板 ↗</button></template><template v-else-if="dialog.type === 'export'"><div class="modal-kicker">EXPORT YOUR WORK</div><h2>导出整张宫格</h2><p>按 {{ activeProject.canvas.width }} × {{ activeProject.canvas.height }} 像素生成清晰图片。</p><div class="modal-field"><span>文件格式</span><div class="format-options"><button :class="{ active: exportFormat === 'png' }" @click="exportFormat = 'png'"><strong>PNG</strong><small>清晰无损</small></button><button :class="{ active: exportFormat === 'jpg' }" @click="exportFormat = 'jpg'"><strong>JPG</strong><small>文件更小</small></button></div></div><label v-if="exportFormat === 'jpg'" class="quality-field">画质 <strong>{{ Math.round(jpegQuality * 100) }}%</strong><input v-model.number="jpegQuality" type="range" min="0.7" max="1" step="0.01" /></label><button class="button button-dark modal-primary" :disabled="savingFile" @click="exportImage">{{ savingFile ? '正在生成…' : `导出 ${exportFormat.toUpperCase()} 图片 ↗` }}</button></template></div></div>

    <div v-if="assetPicker" class="modal-backdrop" @click.self="assetPicker = false"><div class="modal-card library-modal"><button class="modal-close" aria-label="关闭" @click="assetPicker = false">×</button><div class="modal-kicker">IMAGE LIBRARY</div><h2>我的图片素材</h2><p>{{ pickerCellId ? '选择一张图片放入当前格子。' : '你上传的图片会保存在当前浏览器中，供不同作品复用。' }}</p><button class="button button-outline library-upload" @click="triggerUpload(pickerCellId)">＋ 上传新图片</button><div class="asset-grid"><div v-for="asset in assets" :key="asset.id" class="asset-card"><button class="asset-select" :disabled="!pickerCellId" @click="assignAsset(asset)"><img :src="assetUrls[asset.id]" :alt="asset.name" /><span>{{ asset.name }}</span></button><button class="asset-delete" :aria-label="`删除${asset.name}`" title="删除图片" @click="removeAsset(asset)">×</button></div><p v-if="!assets.length" class="asset-empty">还没有图片素材。上传一张开始吧。</p></div></div></div>

    <div v-if="toast" class="toast" :class="toast.kind"><span>{{ toast.kind === 'error' ? '!' : '✓' }}</span>{{ toast.message }}<button aria-label="关闭提示" @click="toast = null">×</button></div>
  </div>
</template>
