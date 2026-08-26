const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function obtenerTodasLasVentasMes(inicioMes, finMes) {
  let todas = [];
  let desde = 0;
  const paso = 1000;
  let hayMas = true;

  while (hayMas) {
    const { data, error } = await supabase
      .from('Ventas_detalle')
      .select('*')
      .gte('fecha', inicioMes)
      .lte('fecha', finMes)
      .range(desde, desde + paso - 1);

    if (error) throw error;

    if (data && data.length > 0) {
      todas = todas.concat(data);
      desde += paso;
      if (data.length < paso) hayMas = false;
    } else {
      hayMas = false;
    }
  }

  return todas;
}

app.get('/api/ventas/consulta-mes', async (req, res) => {
  try {
    const { anio, mes } = req.query;
    if (!anio || !mes) {
      return res.status(400).json({ error: 'Debes enviar anio y mes (ej: ?anio=2026&mes=08)' });
    }

    const mesFormateado = String(mes).padStart(2, '0');
    const anioFormateado = String(anio);

    const inicioMes = `${anioFormateado}-${mesFormateado}-01`;
    const ultimoDia = new Date(Number(anioFormateado), Number(mesFormateado), 0).getDate();
    const finMes = `${anioFormateado}-${mesFormateado}-${ultimoDia}`;

    const ventas = await obtenerTodasLasVentasMes(inicioMes, finMes);

    // 1. Facturación Total
    const totalVendido = ventas.reduce((acc, curr) => acc + (Number(curr.total) || 0), 0);

    // 2. Ranking de Vendedores
    const mapaVendedores = {};
    ventas.forEach(v => {
      const nombre = (v.nombre_vendedor || v.vendedor || 'Sin Vendedor').toLowerCase();
      const monto = Number(v.total) || 0;
      mapaVendedores[nombre] = (mapaVendedores[nombre] || 0) + monto;
    });

    const vendedores = Object.keys(mapaVendedores)
      .map(nombre => ({ vendedor: nombre, monto: mapaVendedores[nombre] }))
      .sort((a, b) => b.monto - a.monto);

    // 3. Evolución Diaria (Día 1 al último día del mes)
    const ventasPorDia = {};
    for (let d = 1; d <= ultimoDia; d++) {
      ventasPorDia[d] = 0;
    }

    ventas.forEach(v => {
      if (v.fecha) {
        const diaStr = v.fecha.substring(8, 10);
        const diaNum = parseInt(diaStr, 10);
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
      resumen: {
        totalVendido,
        vendedores,
        evolucionDiaria
      }
    });

  } catch (err) {
    console.error('Error en API:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ventas/mes-actual', (req, res) => {
  const ahora = new Date();
  const anio = ahora.getFullYear();
  const mes = String(ahora.getMonth() + 1).padStart(2, '0');
  res.redirect(`/api/ventas/consulta-mes?anio=${anio}&mes=${mes}`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor ejecutándose en http://localhost:${PORT}`));