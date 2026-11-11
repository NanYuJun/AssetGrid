const DB_NAME = 'assetgrid'
const DB_VERSION = 1

let opening

export function openDatabase() {
  if (opening) return opening

  opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('templates')) db.createObjectStore('templates', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

  return opening
}

async function requestStore(storeName, mode, operation) {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode)
    const request = operation(transaction.objectStore(storeName))
    transaction.oncomplete = () => resolve(request?.result)
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

export const listProjects = () => requestStore('projects', 'readonly', store => store.getAll())
export const listTemplates = () => requestStore('templates', 'readonly', store => store.getAll())
export const listAssets = () => requestStore('assets', 'readonly', store => store.getAll())
export const getAsset = id => requestStore('assets', 'readonly', store => store.get(id))
export const putProject = project => requestStore('projects', 'readwrite', store => store.put(project))
export const putTemplate = template => requestStore('templates', 'readwrite', store => store.put(template))
export const putAsset = asset => requestStore('assets', 'readwrite', store => store.put(asset))
export const deleteProject = id => requestStore('projects', 'readwrite', store => store.delete(id))
export const deleteTemplate = id => requestStore('templates', 'readwrite', store => store.delete(id))
export const deleteAsset = id => requestStore('assets', 'readwrite', store => store.delete(id))

export async function importPackage(project, assets) {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['projects', 'assets'], 'readwrite')
    for (const asset of assets) transaction.objectStore('assets').put(asset)
    transaction.objectStore('projects').put(project)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}
