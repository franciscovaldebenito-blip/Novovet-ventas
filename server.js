const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// LISTA DE FERIADOS EN CHILE (Mes, Día)
const FERIADOS_CHILE = [
  [1, 1],   // Año Nuevo
  [4, 3],   // Viernes Santo (2026)
  [4, 4],   // Sábado Santo (2026)
  [5, 1],   // Día del Trabajo
  [5, 21],  // Glorias Navales
  [6, 20],  // Día Nacional de los Pueblos Indígenas
  [6, 29],  // San Pedro y San Pablo
  [7, 16],  // Virgen del Carmen
  [8, 15],  // Asunción de la Virgen
  [9, 18],  // Fiestas Patrias
  [9, 19],  // Glorias del Ejército
  [10, 12], // Encuentro de Dos Mundos
  [10, 31], // Iglesias Evangélicas
  [11, 1],  // Todos los Santos
  [12, 8],  // Inmaculada Concepción
  [12, 25]  // Navidad
];

/**
 * Obtiene el número de semana ISO (1-53) oficial para una fecha dada.
 */
function getISOWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

/**
 * Genera dinámicamente las semanas según su número ISO recortadas al mes,
 * aplicando las reglas de consolidación (<= 2 días hábiles).
 */
function calcularEstructuraMes(anio, mes) {
  const anioNum = Number(anio);
  const mesNum = Number(mes);
  const totalDiasMes = new Date(anioNum, mesNum, 0).getDate();

  const semanasMapa = {};
  let totalDiasHabilesMes = 0;

  for (let d = 1; d <= totalDiasMes; d++) {
    const fechaObj = new Date(anioNum, mesNum - 1, d);
    const numSemana = getISOWeekNumber(fechaObj);
    const diaSemana = fechaObj.getDay(); // 0: Dom, 6: Sáb

    const esFinDeSemana = (diaSemana === 0 || diaSemana === 6);
    const esFeriado = FERIADOS_CHILE.some(([m, day]) => m === mesNum && day === d);
    const esHabil = !esFinDeSemana && !esFeriado;

    if (!semanasMapa[numSemana]) {
      semanasMapa[numSemana] = {
        numSemana: numSemana,
        inicio: d,
        fin: d,
        diasHabiles: 0
      };
    }

    semanasMapa[numSemana].fin = d;
    if (esHabil) {
      semanasMapa[numSemana].diasHabiles++;
      totalDiasHabilesMes++;
    }
  }

  // 1. Descartar semanas sin días hábiles
  let tramosCrudos = Object.values(semanasMapa).filter(t => t.diasHabiles > 0);

  // 2. Fusionar semana inicial si tiene <= 2 días hábiles a la siguiente
  if (tramosCrudos.length > 1 && tramosCrudos[0].diasHabiles <= 2) {
    tramosCrudos[1].inicio = tramosCrudos[0].inicio;
    tramosCrudos[1].diasHabiles += tramosCrudos[0].diasHabiles;
    tramosCrudos.shift();
  }

  // 3. Fusionar semana final si tiene <= 2 días hábiles a la anterior
  if (tramosCrudos.length > 1 && tramosCrudos[tramosCrudos.length - 1].diasHabiles <= 2) {
    const ultimo = tramosCrudos.pop();
    const penultimo = tramosCrudos[tramosCrudos.length - 1];
    penultimo.fin = ultimo.fin;
    penultimo.diasHabiles += ultimo.diasHabiles;
  }

  // 4. Mapear tramos limpios
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

// Función auxiliar para traer ventas por lotes desde Supabase
async function traerTodoElRango(fechaInicio, fechaFin) {
  let registros = [];
  let desde = 0;
  const paso = 1000;
  let continuar = true;

  while (continuar && desde < 30000) {
    const { data, error } = await supabase
      .from('Ventas_detalle')
      .select('fecha, total, nombre_vendedor, vendedor')
      .gte('fecha', fechaInicio)
      .lte('fecha', fechaFin)
      .range(desde, desde + paso - 1);

    if (error || !data || data.length === 0) {
      continuar = false;
    } else {
      registros = registros.concat(data);
      desde += paso;
      if (data.length < paso) continuar = false;
    }
  }
  return registros;
}

// Función desacoplada para la consulta de resumen mensual
async function procesarConsultaMes(req, res) {
  try {
    const { anio, mes, rol, vendedorLogueado } = req.query;
    if (!anio || !mes) return res.status(400).json({ error: 'Faltan parámetros anio/mes' });

    const mesStr = String(mes).padStart(2, '0');
    const anioStr = String(anio);
    const inicioMes = `${anioStr}-${mesStr}-01T00:00:00`;
    const ultimoDia = new Date(Number(anioStr), Number(mesStr), 0).getDate();
    const finMes = `${anioStr}-${mesStr}-${String(ultimoDia).padStart(2, '0')}T23:59:59`;

    let ventas = await traerTodoElRango(inicioMes, finMes);

    // Filtrar únicamente los datos del vendedor si su rol es 'vendedor'
    if (rol === 'vendedor' && vendedorLogueado) {
      const vendTarget = vendedorLogueado.toLowerCase().trim();
      ventas = ventas.filter(v => {
        const nom = String(v.nombre_vendedor || v.vendedor || '').toLowerCase().trim();
        return nom.includes(vendTarget) || vendTarget.includes(nom);
      });
    }

    const totalVendido = ventas.reduce((acc, curr) => acc + (Number(curr.total) || 0), 0);

    const mapaVendedores = {};
    ventas.forEach(v => {
      const nom = (v.nombre_vendedor || v.vendedor || 'Sin Vendedor').toLowerCase().trim();
      mapaVendedores[nom] = (mapaVendedores[nom] || 0) + (Number(v.total) || 0);
    });

    const vendedores = Object.keys(mapaVendedores)
      .map(nombre => ({ vendedor: nombre, monto: mapaVendedores[nombre] }))
      .sort((a, b) => b.monto - a.monto);

    const ventasPorDia = {};
    for (let d = 1; d <= ultimoDia; d++) ventasPorDia[d] = 0;

    ventas.forEach(v => {
      if (v.fecha) {
        const diaNum = parseInt(String(v.fecha).substring(8, 10), 10);
        if (ventasPorDia[diaNum] !== undefined) {
          ventasPorDia[diaNum] += Number(v.total) || 0;
        }
      }
    });

    const evolucionDiaria = Object.keys(ventasPorDia).map(dia => ({
      dia: Number(dia),
      monto: ventasPorDia[dia]
    }));

    res.json({
      periodo: { inicio: inicioMes, fin: finMes, ultimoDia },
      resumen: { totalVendido, vendedores, evolucionDiaria, totalRegistros: ventas.length }
    });

  } catch (err) {
    console.error('Error en consulta-mes:', err.message);
    res.status(500).json({ error: err.message });
  }
}

// ==========================================
// 1. AUTENTICACIÓN / LOGIN
// ==========================================
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Debes ingresar email y contraseña' });
    }

    const { data: usuarios, error } = await supabase
      .from('usuarios')
      .select('*');

    if (error) {
      return res.status(500).json({ error: 'Error al consultar la base de datos: ' + error.message });
    }

    if (!usuarios || usuarios.length === 0) {
      return res.status(401).json({ error: 'No se encontraron usuarios registrados' });
    }

    const usuario = usuarios.find(u => 
      String(u.email).trim().toLowerCase() === String(email).trim().toLowerCase()
    );

    if (!usuario) {
      return res.status(401).json({ error: 'El correo ingresado no existe en la base de datos' });
    }

    if (String(usuario.password).trim() !== String(password).trim()) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    const usuarioSesion = {
      id: usuario.id,
      nombre: usuario.nombre,
      email: usuario.email,
      rol: String(usuario.rol).toLowerCase(),
      vendedor_vinculado: usuario.vendedor_vinculado || usuario.nombre
    };

    res.json({ usuario: usuarioSesion });
  } catch (err) {
    console.error('Error en /api/login:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 2. GESTIÓN DE USUARIOS / ACCESOS (ADMIN)
// ==========================================
app.get('/api/usuarios', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('usuarios')
      .select('id, nombre, email, rol, vendedor_vinculado');
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/vendedores/lista', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('metas_vendedores')
      .select('nombre');

    if (error) throw error;

    const vendedoresUnicos = [...new Set(
      (data || [])
        .map(item => (item.nombre || '').trim())
        .filter(n => n !== '')
    )].sort((a, b) => a.localeCompare(b));
    
    res.json(vendedoresUnicos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/usuarios/guardar', async (req, res) => {
  try {
    const { id, nombre, email, password, rol, vendedor_vinculado } = req.body;
    if (!email || !nombre || !rol) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    const payload = {
      nombre: nombre.trim(),
      email: email.trim().toLowerCase(),
      rol: rol.trim().toUpperCase(),
      vendedor_vinculado: vendedor_vinculado ? vendedor_vinculado.trim() : nombre.trim()
    };

    if (password && password.trim() !== '') {
      payload.password = password.trim();
    }

    let result;
    if (id) {
      result = await supabase.from('usuarios').update(payload).eq('id', id);
    } else {
      if (!password) return res.status(400).json({ error: 'La contraseña es requerida para nuevos usuarios' });
      result = await supabase.from('usuarios').insert([payload]);
    }

    if (result.error) throw result.error;
    res.json({ ok: true, mensaje: 'Usuario guardado correctamente' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// GUARDAR METAS MASIVAMENTE (ADMIN)
// ==========================================
app.post('/api/ventas/metas/guardar-masivo', async (req, res) => {
  try {
    const { anio, mes, metas } = req.body; // metas es un array: [{ vendedor: 'Carol', meta: 15000000 }, ...]

    if (!anio || !mes || !Array.isArray(metas)) {
      return res.status(400).json({ error: 'Faltan parámetros obligatorios (anio, mes, metas)' });
    }

    // Filtrar solo los registros que tienen un monto válido asignado
    const payload = metas
      .filter(item => item.vendedor && item.meta !== '' && item.meta !== null && !isNaN(item.meta))
      .map(item => ({
        anio: Number(anio),
        mes: Number(mes),
        nombre: item.vendedor.trim(),
        meta: Number(item.meta)
      }));

    if (payload.length === 0) {
      return res.status(400).json({ error: 'No se ingresaron montos válidos para guardar.' });
    }

    const { error } = await supabase
      .from('metas_vendedores')
      .upsert(payload, { onConflict: 'anio,mes,nombre' });

    if (error) throw error;

    res.json({ ok: true, mensaje: 'Metas actualizadas correctamente' });
  } catch (err) {
    console.error('Error en /api/ventas/metas/guardar-masivo:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. CONSULTA DE METAS Y CUMPLIMIENTO
// ==========================================
app.get('/api/ventas/metas', async (req, res) => {
  try {
    const { anio, mes } = req.query;
    if (!anio || !mes) return res.status(400).json({ error: 'Faltan anio/mes' });

    const mesNum = parseInt(mes, 10);
    const anioNum = parseInt(anio, 10);
    const mesStr = String(mesNum).padStart(2, '0');
    
    const estructuraMes = calcularEstructuraMes(anioNum, mesNum);
    const inicioMes = `${anioNum}-${mesStr}-01T00:00:00`;
    const finMes = `${anioNum}-${mesStr}-${String(estructuraMes.totalDiasMes).padStart(2, '0')}T23:59:59`;

    const ventas = await traerTodoElRango(inicioMes, finMes);

    const { data: metasData, error: errMetas } = await supabase
      .from('metas_vendedores')
      .select('*')
      .eq('anio', anioNum)
      .eq('mes', mesNum);

    if (errMetas) console.error('Error consultando metas_vendedores:', errMetas);

    const metasMap = {};
    if (metasData && metasData.length > 0) {
      metasData.forEach(m => {
        const rawNombre = m.nombre || m.Nombre || m.vendedor || m.VENDEDOR || '';
        let valorMeta = 0;
        if (m.meta !== undefined && m.meta !== null) valorMeta = parseFloat(m.meta);
        else if (m.Meta !== undefined && m.Meta !== null) valorMeta = parseFloat(m.Meta);

        if (isNaN(valorMeta)) valorMeta = 0;

        const key = String(rawNombre).toLowerCase().trim();
        if (key) metasMap[key] = { nombreOriginal: rawNombre, meta: valorMeta, correo: m.correo || m.Correo || m.email || '' };
      });
    }

    const acumVendedores = {};
    ventas.forEach(v => {
      const nomOriginal = String(v.nombre_vendedor || v.vendedor || 'Sin Vendedor').trim();
      const nomKey = nomOriginal.toLowerCase();
      const monto = Number(v.total) || 0;
      const dia = v.fecha ? parseInt(String(v.fecha).substring(8, 10), 10) : 1;

      if (!acumVendedores[nomKey]) {
        acumVendedores[nomKey] = { nombre: nomOriginal, totalMes: 0, ventasPorDia: {} };
      }

      acumVendedores[nomKey].totalMes += monto;
      acumVendedores[nomKey].ventasPorDia[dia] = (acumVendedores[nomKey].ventasPorDia[dia] || 0) + monto;
    });

    const todasLasKeys = Array.from(new Set([...Object.keys(acumVendedores), ...Object.keys(metasMap)]));

    const resultado = todasLasKeys.map(key => {
      const vData = acumVendedores[key] || { nombre: key, totalMes: 0, ventasPorDia: {} };
      const mData = metasMap[key] || { nombreOriginal: key, meta: 0, correo: '' };

      const metaMensual = Math.round(mData.meta);
      const totalHabiles = estructuraMes.totalDiasHabilesMes;
      const metaDiaria = (metaMensual > 0 && totalHabiles > 0) ? (metaMensual / totalHabiles) : 0;

      const semanasCalculadas = estructuraMes.tramos.map(t => {
        let vendidoTramo = 0;
        for (let d = t.inicio; d <= t.fin; d++) {
          vendidoTramo += (vData.ventasPorDia[d] || 0);
        }

        const metaTramo = Math.round(metaDiaria * t.diasHabiles);
        const pctTramo = metaTramo > 0 ? Math.round((vendidoTramo / metaTramo) * 100) : 0;

        return {
          semana: t.num,
          numSemana: t.numSemana,
          label: t.label,
          inicio: t.inicio,
          fin: t.fin,
          diasHabiles: t.diasHabiles,
          vendido: Math.round(vendidoTramo),
          metaTramo: metaTramo,
          pct: pctTramo
        };
      });

      return {
        vendedor: mData.nombreOriginal || vData.nombre,
        correo: mData.correo,
        metaMensual,
        diasHabilesMes: totalHabiles,
        vendidoMes: Math.round(vData.totalMes),
        porcentajeMes: metaMensual > 0 ? Math.round((vData.totalMes / metaMensual) * 100) : 0,
        semanas: semanasCalculadas
      };
    }).sort((a, b) => b.vendidoMes - a.vendidoMes);

    res.json(resultado);

  } catch (err) {
    console.error('Error en metas:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 5. CONSULTA DE VENTAS DETALLE CON ROL
// ==========================================
app.get('/api/ventas/detalle', async (req, res) => {
  try {
    const { desde, hasta, vendedor, busqueda, pagina = 1, limite = 100, rol, vendedorLogueado } = req.query;
    if (!desde || !hasta) return res.status(400).json({ error: 'Faltan parámetros desde/hasta' });

    const dInicio = new Date(desde);
    const dFin = new Date(hasta);
    const diffDias = Math.ceil((dFin - dInicio) / (1000 * 60 * 60 * 24)) + 1;

    if (diffDias > 31) return res.status(400).json({ error: 'El rango máximo de consulta es de 31 días (1 mes).' });
    if (dFin < dInicio) return res.status(400).json({ error: 'La fecha "Hasta" no puede ser anterior a "Desde".' });

    const fechaInicio = `${desde}T00:00:00`;
    const fechaFin = `${hasta}T23:59:59`;

    const offset = (Number(pagina) - 1) * Number(limite);
    const hastaOffset = offset + Number(limite) - 1;

    let query = supabase
      .from('Ventas_detalle')
      .select('*', { count: 'exact' })
      .gte('fecha', fechaInicio)
      .lte('fecha', fechaFin)
      .order('fecha', { ascending: false })
      .range(offset, hastaOffset);

    let vendedorAFiltrar = vendedor;
    if (rol === 'vendedor' && vendedorLogueado) {
      vendedorAFiltrar = vendedorLogueado;
    }

    // Construcción limpia de filtros combinados usando PostgREST and/or
    const filtrosAnd = [];

    if (vendedorAFiltrar && vendedorAFiltrar.trim() !== '') {
      const vClean = vendedorAFiltrar.trim();
      filtrosAnd.push(`or(nombre_vendedor.ilike.%${vClean}%,vendedor.ilike.%${vClean}%)`);
    }

    if (busqueda && busqueda.trim() !== '') {
      const bClean = busqueda.trim();
      filtrosAnd.push(`or(nombre_cliente.ilike.%${bClean}%,cliente.ilike.%${bClean}%)`);
    }

    if (filtrosAnd.length > 0) {
      query = query.and(filtrosAnd.join(','));
    }

    const { data: ventas, count, error } = await query;
    if (error) throw error;

    const detalle = (ventas || []).map(v => ({
      fecha: v.fecha ? String(v.fecha).substring(0, 10) : '',
      vendedor: (v.nombre_vendedor || v.vendedor || 'Sin Vendedor').toLowerCase(),
      cliente: v.nombre_cliente || v.cliente || 'Cliente General',
      doc: v.nro_factura || v.numero_documento || v.documento || v.id || '-',
      monto: Number(v.total) || 0
    }));

    res.json({
      totalRegistros: count || 0,
      paginaActual: Number(pagina),
      limite: Number(limite),
      totalPaginas: Math.ceil((count || 0) / Number(limite)),
      detalle
    });

  } catch (err) {
    console.error('Error en detalle:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 6. CONSULTA RESUMEN INICIAL Y REDIRECCIÓN
// ==========================================
app.get('/api/ventas/consulta-mes', procesarConsultaMes);

// Redirección interna asignando dinámicamente año y mes actuales a req.query
app.get('/api/ventas/mes-actual', (req, res) => {
  const ahora = new Date();
  
  req.query.anio = req.query.anio || String(ahora.getFullYear());
  req.query.mes = req.query.mes || String(ahora.getMonth() + 1).padStart(2, '0');
  
  return procesarConsultaMes(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor NOVOVET activo en puerto ${PORT}`));