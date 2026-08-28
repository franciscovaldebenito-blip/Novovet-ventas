const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// CACHÉ EN MEMORIA
let cacheVentas = null;
let cacheUsuariosMap = {};
let cacheUltimaActualizacion = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

const FERIADOS_CHILE = [
  [1, 1], [4, 3], [4, 4], [5, 1], [5, 21], [6, 20], [6, 29],
  [7, 16], [8, 15], [9, 18], [9, 19], [10, 12], [10, 31], [11, 1], [12, 8], [12, 25]
];

function getISOWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function calcularEstructuraMes(anio, mes) {
  const anioNum = Number(anio);
  const mesNum = Number(mes);
  const totalDiasMes = new Date(anioNum, mesNum, 0).getDate();

  const semanasMapa = {};
  let totalDiasHabilesMes = 0;

  for (let d = 1; d <= totalDiasMes; d++) {
    const fechaObj = new Date(anioNum, mesNum - 1, d);
    const numSemana = getISOWeekNumber(fechaObj);
    const diaSemana = fechaObj.getDay();

    const esFinDeSemana = (diaSemana === 0 || diaSemana === 6);
    const esFeriado = FERIADOS_CHILE.some(([m, day]) => Number(m) === mesNum && Number(day) === d);
    const esHabil = !esFinDeSemana && !esFeriado;

    if (!semanasMapa[numSemana]) {
      semanasMapa[numSemana] = { numSemana, inicio: d, fin: d, diasHabiles: 0 };
    }

    semanasMapa[numSemana].fin = d;
    if (esHabil) {
      semanasMapa[numSemana].diasHabiles++;
      totalDiasHabilesMes++;
    }
  }

  let tramosCrudos = Object.values(semanasMapa).filter(t => t.diasHabiles > 0);

  // 1. Regla de inicio: Si la primera semana tiene 1 o 2 días hábiles, se agrupa a la siguiente
  if (tramosCrudos.length > 1 && tramosCrudos[0].diasHabiles <= 2) {
    tramosCrudos[1].inicio = tramosCrudos[0].inicio;
    tramosCrudos[1].diasHabiles += tramosCrudos[0].diasHabiles;
    tramosCrudos.shift();
  }

  // 2. Regla de fin: Si la última semana tiene 1 o 2 días hábiles, se agrupa a la anterior
  if (tramosCrudos.length > 1) {
    const ultIdx = tramosCrudos.length - 1;
    if (tramosCrudos[ultIdx].diasHabiles <= 2) {
      const ultimo = tramosCrudos.pop();
      tramosCrudos[tramosCrudos.length - 1].fin = ultimo.fin;
      tramosCrudos[tramosCrudos.length - 1].diasHabiles += ultimo.diasHabiles;
    }
  }

  const tramos = tramosCrudos.map((t, index) => ({
    num: index + 1,
    numSemana: t.numSemana,
    inicio: t.inicio,
    fin: t.fin,
    label: `Sem ${t.numSemana} (${t.inicio}-${t.fin})`,
    diasHabiles: t.diasHabiles
  }));

  return { totalDiasMes, totalDiasHabilesMes, tramos };
}

function extraerMonto(v) {
  const val = v.total ?? v.Total ?? v.monto ?? v.Monto ?? v.precio_total ?? 0;
  return Math.round(Number(val)) || 0;
}

function extraerVendedor(v, mapaUsuarios = {}) {
  const raw = v.nombre_vendedor || v.vendedor || v.Nombre_Vendedor || v.Vendedor || '';
  const key = String(raw).trim();
  if (mapaUsuarios[key]) return mapaUsuarios[key];
  if (!isNaN(key) && key !== '') return `Vendedor ${key}`;
  return key || 'Sin Vendedor';
}

function extraerCliente(v) {
  return String(v.cliente || v.nombre_cliente || v.Nombre_Cliente || v.Cliente || 'Cliente General').trim();
}

function extraerProveedor(v) {
  const p = v.grupo ?? v.grupo_proveedor ?? v.proveedor ?? v.nombre_proveedor ?? v.Proveedor;
  if (!p || String(p).trim() === '' || String(p).toLowerCase() === 'null') return 'Sin Proveedor';
  return String(p).trim();
}

function extraerAnioMes(v) {
  const f = v.fecha || v.Fecha || v.created_at;
  if (!f) return { anio: null, mes: null, dia: null };

  const str = String(f).trim();
  if (str.includes('-')) {
    const soloFecha = str.split('T')[0].split(' ')[0];
    const partes = soloFecha.split('-');
    if (partes.length >= 3) {
      return { anio: parseInt(partes[0], 10), mes: parseInt(partes[1], 10), dia: parseInt(partes[2], 10) };
    }
  }
  if (str.includes('/')) {
    const soloFecha = str.split(' ')[0];
    const partes = soloFecha.split('/');
    if (partes.length >= 3) {
      if (partes[0].length === 4) {
        return { anio: parseInt(partes[0], 10), mes: parseInt(partes[1], 10), dia: parseInt(partes[0], 10) };
      }
      return { anio: parseInt(partes[2], 10), mes: parseInt(partes[1], 10), dia: parseInt(partes[0], 10) };
    }
  }
  return { anio: null, mes: null, dia: null };
}

function obtenerUltimos3MesesInfo(refAnio, refMes) {
  const nombres = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
  const mAct = refMes ? parseInt(refMes, 10) : 8;
  const aAct = refAnio ? parseInt(refAnio, 10) : 2026;

  const fechaAct = new Date(aAct, mAct - 1, 1);
  const fechaM1 = new Date(aAct, mAct - 2, 1);
  const fechaM2 = new Date(aAct, mAct - 3, 1);

  return {
    mesesNombres: [
      nombres[fechaM2.getMonth()],
      nombres[fechaM1.getMonth()],
      nombres[fechaAct.getMonth()]
    ],
    m2: { anio: fechaM2.getFullYear(), mes: fechaM2.getMonth() + 1 },
    m1: { anio: fechaM1.getFullYear(), mes: fechaM1.getMonth() + 1 },
    mAct: { anio: fechaAct.getFullYear(), mes: fechaAct.getMonth() + 1 }
  };
}

function coincidenNombres(nombreA, nombreB) {
  if (!nombreA || !nombreB) return false;
  const a = String(nombreA).toLowerCase().trim();
  const b = String(nombreB).toLowerCase().trim();
  if (a === b || a.includes(b) || b.includes(a)) return true;

  const partesA = a.split(' ').filter(x => x.length > 2);
  const partesB = b.split(' ').filter(x => x.length > 2);
  return partesA.some(p => partesB.includes(p));
}

async function obtenerDatosRpidos(forzarRecarga = false) {
  const ahora = Date.now();
  if (!forzarRecarga && cacheVentas && (ahora - cacheUltimaActualizacion < CACHE_TTL_MS)) {
    return { registros: cacheVentas, usuariosMap: cacheUsuariosMap };
  }

  try {
    const { data: userLogs } = await supabase.from('usuarios').select('id, nombre, vendedor_vinculado');
    const mapa = {};
    (userLogs || []).forEach(u => {
      if (u.id) mapa[String(u.id)] = u.nombre || u.vendedor_vinculado;
      if (u.vendedor_vinculado) mapa[String(u.vendedor_vinculado).trim()] = u.nombre || u.vendedor_vinculado;
    });
    cacheUsuariosMap = mapa;

    let todos = [];
    let desde = 0;
    const paso = 1000;
    let continuar = true;

    while (continuar && desde < 50000) {
      let { data } = await supabase.from('Ventas_detalle').select('*').range(desde, desde + paso - 1);
      if (data && data.length > 0) {
        todos = todos.concat(data);
        desde += paso;
        if (data.length < paso) continuar = false;
      } else {
        continuar = false;
      }
    }

    cacheVentas = todos;
    cacheUltimaActualizacion = ahora;
    return { registros: cacheVentas, usuariosMap: cacheUsuariosMap };
  } catch (err) {
    if (cacheVentas) return { registros: cacheVentas, usuariosMap: cacheUsuariosMap };
    throw err;
  }
}

app.get('/api/vendedores/lista-completa', async (req, res) => {
  try {
    const { registros: datos, usuariosMap } = await obtenerDatosRpidos();
    const vendedoresSet = new Set();
    datos.forEach(v => {
      const nom = extraerVendedor(v, usuariosMap);
      if (nom && nom !== 'Sin Vendedor') vendedoresSet.add(nom);
    });
    res.json(Array.from(vendedoresSet).sort((a, b) => a.localeCompare(b)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ventas/consulta-mes', async (req, res) => {
  try {
    let { anio = 2026, mes = 8, vendedorLogueado, forzar } = req.query;
    let mesNum = parseInt(mes, 10);
    let anioNum = parseInt(anio, 10);
    const vendedorFiltro = vendedorLogueado ? decodeURIComponent(vendedorLogueado).trim() : '';

    const { registros: todasVentas, usuariosMap } = await obtenerDatosRpidos(forzar === 'true');
    const { data: metasData } = await supabase.from('metas_vendedores').select('*').eq('anio', anioNum).eq('mes', mesNum);

    const metasMap = {};
    (metasData || []).forEach(m => {
      if (m.nombre) metasMap[m.nombre.toLowerCase().trim()] = Number(m.meta) || 0;
    });

    let ventasMes = todasVentas.filter(v => {
      const { anio: aVenta, mes: mVenta } = extraerAnioMes(v);
      return aVenta === anioNum && mVenta === mesNum;
    });

    let ventasFiltradas = ventasMes;
    const esVendedorEspecifico = vendedorFiltro !== '';

    if (esVendedorEspecifico) {
      ventasFiltradas = ventasMes.filter(v => coincidenNombres(extraerVendedor(v, usuariosMap), vendedorFiltro));
    }

    const mapaVendedores = {};
    ventasFiltradas.forEach(v => {
      const nom = extraerVendedor(v, usuariosMap);
      if (!mapaVendedores[nom]) mapaVendedores[nom] = 0;
      mapaVendedores[nom] += extraerMonto(v);
    });

    const vendedores = Object.keys(mapaVendedores)
      .map(nombre => {
        const monto = mapaVendedores[nombre];
        const keyMeta = Object.keys(metasMap).find(k => coincidenNombres(k, nombre));
        const meta = keyMeta ? metasMap[keyMeta] : 0;
        const pct = meta > 0 ? Math.round((monto / meta) * 100) : 0;
        return { vendedor: nombre, monto, meta, pct };
      })
      .sort((a, b) => b.monto - a.monto);

    const ultimoDia = new Date(anioNum, mesNum, 0).getDate();
    const ventasPorDia = {};
    for (let d = 1; d <= ultimoDia; d++) ventasPorDia[d] = 0;

    ventasFiltradas.forEach(v => {
      const { dia } = extraerAnioMes(v);
      if (dia && ventasPorDia[dia] !== undefined) ventasPorDia[dia] += extraerMonto(v);
    });

    const evolucionDiaria = Object.keys(ventasPorDia).map(dia => ({ dia: Number(dia), monto: ventasPorDia[dia] }));

    res.json({
      periodo: { anio: anioNum, mes: mesNum },
      resumen: {
        totalVendido: vendedores.reduce((acc, curr) => acc + curr.monto, 0),
        vendedores,
        evolucionDiaria
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ventas/detalle', async (req, res) => {
  try {
    const { vendedor, busqueda, anio = 2026, mes = 8, soloSinCompra = 'false' } = req.query;
    const vendFiltro = vendedor ? decodeURIComponent(vendedor).trim() : '';
    const busqFiltro = busqueda ? decodeURIComponent(busqueda).trim() : '';

    const { registros: datos, usuariosMap } = await obtenerDatosRpidos();
    const infoMeses = obtenerUltimos3MesesInfo(anio, mes);

    let filtrados = datos;
    if (vendFiltro !== '') {
      filtrados = filtrados.filter(v => coincidenNombres(extraerVendedor(v, usuariosMap), vendFiltro));
    }

    if (busqFiltro !== '') {
      const bTarget = busqFiltro.toLowerCase();
      filtrados = filtrados.filter(v => extraerCliente(v).toLowerCase().includes(bTarget));
    }

    const mapaClientes = {};
    filtrados.forEach(v => {
      const cliente = extraerCliente(v);
      const monto = extraerMonto(v);
      const { anio: aV, mes: mV } = extraerAnioMes(v);

      if (!mapaClientes[cliente]) {
        mapaClientes[cliente] = { cliente, mes_2: 0, mes_1: 0, mes_actual: 0 };
      }

      if (aV === infoMeses.m2.anio && mV === infoMeses.m2.mes) mapaClientes[cliente].mes_2 += monto;
      else if (aV === infoMeses.m1.anio && mV === infoMeses.m1.mes) mapaClientes[cliente].mes_1 += monto;
      else if (aV === infoMeses.mAct.anio && mV === infoMeses.mAct.mes) mapaClientes[cliente].mes_actual += monto;
    });

    let listaDetalle = Object.values(mapaClientes);

    // Filtro para mostrar clientes sin compra en el mes seleccionado
    if (soloSinCompra === 'true') {
      listaDetalle = listaDetalle.filter(c => c.mes_actual === 0 && (c.mes_1 > 0 || c.mes_2 > 0));
    }

    res.json({
      mesesNombres: infoMeses.mesesNombres,
      detalle: listaDetalle.sort((a, b) => b.mes_actual - a.mes_actual || b.mes_1 - a.mes_1)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ventas/proveedores', async (req, res) => {
  try {
    const { vendedor, busqueda, anio = 2026, mes = 8 } = req.query;
    const vendFiltro = vendedor ? decodeURIComponent(vendedor).trim() : '';
    const busqFiltro = busqueda ? decodeURIComponent(busqueda).trim() : '';

    const { registros: datos, usuariosMap } = await obtenerDatosRpidos();
    const infoMeses = obtenerUltimos3MesesInfo(anio, mes);

    let filtrados = datos;
    if (vendFiltro !== '') {
      filtrados = filtrados.filter(v => coincidenNombres(extraerVendedor(v, usuariosMap), vendFiltro));
    }

    if (busqFiltro !== '') {
      const bTarget = busqFiltro.toLowerCase();
      filtrados = filtrados.filter(v => extraerProveedor(v).toLowerCase().includes(bTarget));
    }

    const mapaProveedores = {};
    filtrados.forEach(v => {
      const prov = extraerProveedor(v);
      const monto = extraerMonto(v);
      const { anio: aV, mes: mV } = extraerAnioMes(v);

      if (!mapaProveedores[prov]) {
        mapaProveedores[prov] = { proveedor: prov, mes_2: 0, mes_1: 0, mes_actual: 0 };
      }

      if (aV === infoMeses.m2.anio && mV === infoMeses.m2.mes) mapaProveedores[prov].mes_2 += monto;
      else if (aV === infoMeses.m1.anio && mV === infoMeses.m1.mes) mapaProveedores[prov].mes_1 += monto;
      else if (aV === infoMeses.mAct.anio && mV === infoMeses.mAct.mes) mapaProveedores[prov].mes_actual += monto;
    });

    res.json({
      mesesNombres: infoMeses.mesesNombres,
      proveedores: Object.values(mapaProveedores).sort((a, b) => b.mes_actual - a.mes_actual)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ventas/metas', async (req, res) => {
  try {
    const { anio = 2026, mes = 8 } = req.query;
    const mesNum = parseInt(mes, 10);
    const anioNum = parseInt(anio, 10);

    const estructuraMes = calcularEstructuraMes(anioNum, mesNum);
    const { registros: todasVentas, usuariosMap } = await obtenerDatosRpidos();

    // Obtener la lista general completa de todos los vendedores
    const todosLosVendedoresSet = new Set();
    todasVentas.forEach(v => {
      const nom = extraerVendedor(v, usuariosMap);
      if (nom && nom !== 'Sin Vendedor') todosLosVendedoresSet.add(nom);
    });

    const ventas = todasVentas.filter(v => {
      const { anio: aVenta, mes: mVenta } = extraerAnioMes(v);
      return aVenta === anioNum && mVenta === mesNum;
    });

    const { data: metasData } = await supabase.from('metas_vendedores').select('*').eq('anio', anioNum).eq('mes', mesNum);

    const metasMap = {};
    (metasData || []).forEach(m => {
      if (m.nombre) metasMap[m.nombre.toLowerCase().trim()] = { nombreOriginal: m.nombre, meta: Number(m.meta) || 0 };
    });

    const acumVendedores = {};
    ventas.forEach(v => {
      const nomOriginal = extraerVendedor(v, usuariosMap);
      const nomKey = nomOriginal.toLowerCase().trim();
      const monto = extraerMonto(v);
      const { dia } = extraerAnioMes(v);

      if (!acumVendedores[nomKey]) acumVendedores[nomKey] = { nombre: nomOriginal, totalMes: 0, ventasPorDia: {} };
      acumVendedores[nomKey].totalMes += monto;
      if (dia) acumVendedores[nomKey].ventasPorDia[dia] = (acumVendedores[nomKey].ventasPorDia[dia] || 0) + monto;
    });

    // Unir catálogo completo de vendedores con metas guardadas
    const todasKeysMap = new Map();
    Array.from(todosLosVendedoresSet).forEach(v => todasKeysMap.set(v.toLowerCase().trim(), v));
    Object.keys(metasMap).forEach(k => {
      if (!todasKeysMap.has(k)) todasKeysMap.set(k, metasMap[k].nombreOriginal);
    });

    const resultado = Array.from(todasKeysMap.entries()).map(([key, nombreReal]) => {
      const vData = acumVendedores[key] || { nombre: nombreReal, totalMes: 0, ventasPorDia: {} };
      const mData = metasMap[key] || { nombreOriginal: nombreReal, meta: 0 };

      const metaMensual = Math.round(mData.meta);
      const totalHabiles = estructuraMes.totalDiasHabilesMes;
      const metaDiaria = totalHabiles > 0 ? (metaMensual / totalHabiles) : 0;

      const semanasCalculadas = estructuraMes.tramos.map(t => {
        let vendidoTramo = 0;
        for (let d = t.inicio; d <= t.fin; d++) vendidoTramo += (vData.ventasPorDia[d] || 0);
        const metaTramo = Math.round(metaDiaria * t.diasHabiles);

        return {
          label: t.label,
          diasHabiles: t.diasHabiles,
          vendido: Math.round(vendidoTramo),
          metaTramo,
          pct: metaTramo > 0 ? Math.round((vendidoTramo / metaTramo) * 100) : 0
        };
      });

      return {
        vendedor: mData.nombreOriginal || vData.nombre || nombreReal,
        metaMensual,
        vendidoMes: Math.round(vData.totalMes),
        porcentajeMes: metaMensual > 0 ? Math.round((vData.totalMes / metaMensual) * 100) : 0,
        semanas: semanasCalculadas
      };
    }).sort((a, b) => a.vendedor.localeCompare(b.vendedor));

    res.json({ tramos: estructuraMes.tramos, vendedores: resultado });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ventas/metas/guardar', async (req, res) => {
  try {
    const { anio, mes, metas } = req.body;
    for (const m of metas) {
      await supabase.from('metas_vendedores').upsert({
        anio: Number(anio),
        mes: Number(mes),
        nombre: m.nombre,
        meta: Number(m.meta)
      }, { onConflict: 'anio,mes,nombre' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/usuarios', async (req, res) => {
  try {
    const { data, error } = await supabase.from('usuarios').select('*');
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/usuarios/guardar', async (req, res) => {
  try {
    const { nombre, email, password, rol, vendedor_vinculado } = req.body;
    const { error } = await supabase.from('usuarios').insert([{ nombre, email, password, rol, vendedor_vinculado }]);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor optimizado ejecutándose en http://localhost:${PORT}`));