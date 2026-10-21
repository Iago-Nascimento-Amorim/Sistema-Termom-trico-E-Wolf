// db.js — camada de acesso ao IndexedDB
// Três object stores: components, plates, results.
// Tudo baseado em Promises pra ficar fácil de usar com async/await.

const DB_NAME = 'ewolf-thermal-db';
const DB_VERSION = 1;

let dbInstance = null;

function openDB() {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains('components')) {
        const store = db.createObjectStore('components', { keyPath: 'id', autoIncrement: true });
        store.createIndex('name', 'name', { unique: false });
      }

      if (!db.objectStoreNames.contains('plates')) {
        db.createObjectStore('plates', { keyPath: 'id', autoIncrement: true });
      }

      if (!db.objectStoreNames.contains('results')) {
        const store = db.createObjectStore('results', { keyPath: 'id', autoIncrement: true });
        store.createIndex('plateId', 'plateId', { unique: false });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      resolve(dbInstance);
    };

    request.onerror = (event) => reject(event.target.error);
  });
}

function tx(storeName, mode) {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function wrapRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const DB = {
  // ---------- Componentes ----------
  async addComponent(component) {
    const store = await tx('components', 'readwrite');
    return wrapRequest(store.add({ ...component, createdAt: Date.now() }));
  },

  async updateComponent(component) {
    const store = await tx('components', 'readwrite');
    return wrapRequest(store.put(component));
  },

  async deleteComponent(id) {
    const store = await tx('components', 'readwrite');
    return wrapRequest(store.delete(id));
  },

  async getAllComponents() {
    const store = await tx('components', 'readonly');
    return wrapRequest(store.getAll());
  },

  async getComponent(id) {
    const store = await tx('components', 'readonly');
    return wrapRequest(store.get(id));
  },

  // ---------- Placas ----------
  async addPlate(plate) {
    const store = await tx('plates', 'readwrite');
    return wrapRequest(store.add({ ...plate, createdAt: Date.now() }));
  },

  async updatePlate(plate) {
    const store = await tx('plates', 'readwrite');
    return wrapRequest(store.put(plate));
  },

  async deletePlate(id) {
    const store = await tx('plates', 'readwrite');
    return wrapRequest(store.delete(id));
  },

  async getAllPlates() {
    const store = await tx('plates', 'readonly');
    return wrapRequest(store.getAll());
  },

  async getPlate(id) {
    const store = await tx('plates', 'readonly');
    return wrapRequest(store.get(id));
  },

  // ---------- Resultados ----------
  async addResult(result) {
    const store = await tx('results', 'readwrite');
    return wrapRequest(store.add({ ...result, timestamp: Date.now() }));
  },

  async getResultsByPlate(plateId) {
    const store = await tx('results', 'readonly');
    const index = store.index('plateId');
    return wrapRequest(index.getAll(plateId));
  },

  async getLastResult() {
    const store = await tx('results', 'readonly');
    const all = await wrapRequest(store.getAll());
    if (!all.length) return null;
    return all.sort((a, b) => b.timestamp - a.timestamp)[0];
  },

  async getAllResults() {
    const store = await tx('results', 'readonly');
    const all = await wrapRequest(store.getAll());
    return all.sort((a, b) => b.timestamp - a.timestamp);
  },

  async deleteResult(id) {
    const store = await tx('results', 'readwrite');
    return wrapRequest(store.delete(id));
  },

  // ---------- Cascata de exclusão ----------
  // Quando um componente é excluído, toda célula da grade de qualquer
  // placa que apontava pra ele vira 'IRRELEVANT' em vez de ficar
  // referenciando um id que não existe mais.
  async replaceComponentUsageWithIrrelevant(componentId) {
    const store = await tx('plates', 'readwrite');
    const plates = await wrapRequest(store.getAll());

    const affected = plates.filter((plate) =>
      Array.isArray(plate.grid) && plate.grid.some((cell) => cell === componentId)
    );

    for (const plate of affected) {
      const newGrid = plate.grid.map((cell) => (cell === componentId ? 'IRRELEVANT' : cell));
      await wrapRequest(store.put({ ...plate, grid: newGrid }));
    }

    return affected.length;
  }
};

window.DB = DB;
